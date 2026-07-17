/**
 * Scheduler — decides what runs, when, and how many at once.
 *
 * This is the only place in the kernel with concurrency logic. Missions decide
 * what is *runnable*; the scheduler decides what actually *runs*, enforcing the
 * concurrency limit, retry backoff, per-task timeouts, and cancellation.
 *
 * It knows nothing about tools or agents. It is handed a {@link TaskExecutor}
 * and calls it. That is what makes it testable with a two-line fake, and what
 * keeps "how do I run a task" (the runtime's problem) out of "in what order and
 * how many" (this file's problem).
 */

import type { Clock } from './clock.js';
import { CancellationError, TaskTimeoutError, toError } from './errors.js';
import type { EventBus } from './event-bus.js';
import type { KernelEventMap } from './events.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';
import type { Mission, MissionSnapshot } from './mission.js';
import type { MissionId } from './ids.js';
import type { Task } from './task.js';

/**
 * Runs one attempt of one task. Rejecting means the attempt failed; the
 * scheduler decides whether that is a retry, a failure, or a cancellation.
 */
export type TaskExecutor = (task: Task, signal: AbortSignal) => Promise<unknown>;

/** Backoff. Receives the attempt that just failed (1 = first). */
export type RetryDelay = (attempt: number, task: Task) => number;

export interface SchedulerOptions {
  readonly bus: EventBus<KernelEventMap>;
  readonly clock: Clock;
  readonly executor: TaskExecutor;
  readonly logger?: Logger;
  /** Max tasks in flight across all missions. Default 4. */
  readonly concurrency?: number;
  readonly retryDelay?: RetryDelay;
}

/** Exponential backoff, capped at 30s. */
export const defaultRetryDelay: RetryDelay = (attempt) =>
  Math.min(30_000, 100 * 2 ** (attempt - 1));

interface Entry {
  readonly mission: Mission;
  /** Aborts every task of this mission. */
  readonly controller: AbortController;
  readonly resolve: (snapshot: MissionSnapshot) => void;
}

export class Scheduler {
  readonly #bus: EventBus<KernelEventMap>;
  readonly #clock: Clock;
  readonly #executor: TaskExecutor;
  readonly #logger: Logger;
  readonly #concurrency: number;
  readonly #retryDelay: RetryDelay;

  readonly #entries = new Map<MissionId, Entry>();
  readonly #inFlight = new Set<string>();
  #waitingRetries = 0;
  #running = false;
  #drainWaiters: (() => void)[] = [];
  /** Starts true so an idle scheduler that never had work stays quiet. */
  #idleAnnounced = true;

  constructor(options: SchedulerOptions) {
    this.#bus = options.bus;
    this.#clock = options.clock;
    this.#executor = options.executor;
    this.#logger = options.logger ?? noopLogger;
    this.#concurrency = options.concurrency ?? 4;
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Tasks currently executing. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Missions submitted and not yet settled. */
  get activeMissions(): number {
    return this.#entries.size;
  }

  /** Begin dispatching. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#pump();
  }

  /**
   * Stop dispatching new tasks. Running tasks are left alone — to abort them,
   * cancel their missions. Idempotent.
   */
  stop(): void {
    this.#running = false;
  }

  /**
   * Accept a mission. The returned promise settles — never rejects — with the
   * final snapshot once every task is terminal.
   *
   * A mission that fails is a normal outcome the caller inspects, not an
   * exception: a partial result with three of five tasks done is information,
   * and a rejection would throw it away.
   */
  submit(mission: Mission): Promise<MissionSnapshot> {
    return new Promise<MissionSnapshot>((resolve) => {
      const entry: Entry = { mission, controller: new AbortController(), resolve };
      this.#entries.set(mission.id, entry);

      void (async () => {
        await this.#bus.emit('mission:submitted', { mission: mission.snapshot() });
        mission.start();
        await this.#bus.emit('mission:started', { mission: mission.snapshot() });
        // Seeds the graph: promotes every task with no dependencies to ready.
        await this.#applyChanges(mission.refresh(this.#clock.now()));
        await this.#afterProgress(entry);
      })();
    });
  }

  /** Abort a mission's running tasks and cancel everything it had queued. */
  async cancelMission(
    missionId: MissionId,
    reason = 'Mission cancelled',
  ): Promise<void> {
    const entry = this.#entries.get(missionId);
    if (!entry) return;
    await this.#cancelEntry(entry, reason);
  }

  /** Cancel every active mission. */
  async cancelAll(reason = 'Cancelled'): Promise<void> {
    await Promise.all(
      [...this.#entries.values()].map((entry) => this.#cancelEntry(entry, reason)),
    );
  }

  /** Resolve once nothing is running, retrying, or runnable. */
  drain(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }

  async #cancelEntry(entry: Entry, reason: string): Promise<void> {
    // Order matters: mark the queued tasks first so they settle as cancelled,
    // then abort, so in-flight tasks unwind into the same afterProgress pass.
    const changed = entry.mission.requestCancel(reason, this.#clock.now());
    entry.controller.abort(new CancellationError(reason));
    for (const task of changed) {
      await this.#bus.emit('task:cancelled', { task: task.snapshot(), reason });
    }
    await this.#afterProgress(entry);
  }

  /** Dispatch until we hit the concurrency limit or run out of runnable tasks. */
  #pump(): void {
    if (!this.#running) return;
    while (this.#inFlight.size < this.#concurrency) {
      const next = this.#nextTask();
      if (!next) break;
      const { task, entry } = next;
      // Claimed synchronously, before any await, so a task cannot be picked twice.
      task.markRunning(this.#clock.now());
      this.#inFlight.add(task.id);
      this.#idleAnnounced = false;
      void this.#dispatch(task, entry);
    }
  }

  /**
   * Highest-priority runnable task across all missions.
   *
   * Global rather than per-mission: a low-priority task in an old mission should
   * not beat a high-priority one just because its mission was submitted first.
   */
  #nextTask(): { task: Task; entry: Entry } | undefined {
    const now = this.#clock.now();
    let best: { task: Task; entry: Entry } | undefined;
    for (const entry of this.#entries.values()) {
      for (const task of entry.mission.readyTasks(now)) {
        if (
          !best ||
          task.priority > best.task.priority ||
          (task.priority === best.task.priority && task.createdAt < best.task.createdAt)
        ) {
          best = { task, entry };
        }
      }
    }
    return best;
  }

  async #dispatch(task: Task, entry: Entry): Promise<void> {
    const startedAt = this.#clock.now();
    await this.#bus.emit('task:started', { task: task.snapshot() });

    try {
      const result = await this.#execute(task, entry);
      task.markSucceeded(result, this.#clock.now());
      await this.#bus.emit('task:succeeded', {
        task: task.snapshot(),
        durationMs: this.#clock.now() - startedAt,
      });
    } catch (thrown) {
      await this.#handleFailure(task, entry, toError(thrown));
    } finally {
      this.#inFlight.delete(task.id);
    }

    await this.#afterProgress(entry);
  }

  /** One attempt, with the task's timeout applied if it has one. */
  async #execute(task: Task, entry: Entry): Promise<unknown> {
    const taskController = new AbortController();
    const signal = AbortSignal.any([entry.controller.signal, taskController.signal]);

    if (task.timeoutMs === undefined) {
      return await this.#executor(task, signal);
    }

    const timeoutMs = task.timeoutMs;
    const timerController = new AbortController();
    const expiry = this.#clock.sleep(timeoutMs, timerController.signal).then(
      () => {
        taskController.abort(new TaskTimeoutError(task.name, timeoutMs));
        throw new TaskTimeoutError(task.name, timeoutMs);
      },
      // The sleep was cancelled because the work finished first. Never settling
      // is correct here — the race is already decided, and rejecting would
      // surface as an unhandled rejection nobody is listening for.
      () => new Promise<never>(() => undefined),
    );

    try {
      return await Promise.race([this.#executor(task, signal), expiry]);
    } finally {
      timerController.abort();
    }
  }

  async #handleFailure(task: Task, entry: Entry, error: Error): Promise<void> {
    const now = this.#clock.now();

    // Cancellation outranks everything: a task killed by shutdown neither failed
    // nor deserves a retry.
    if (entry.controller.signal.aborted) {
      const reason = error.message;
      task.markCancelled(error, now);
      await this.#bus.emit('task:cancelled', { task: task.snapshot(), reason });
      return;
    }

    if (task.canRetry) {
      const delayMs = Math.max(0, this.#retryDelay(task.attempts, task));
      task.markRetrying(error, now + delayMs);
      await this.#bus.emit('task:retrying', { task: task.snapshot(), error, delayMs });
      this.#scheduleRetry(entry, delayMs);
      return;
    }

    task.markFailed(error, now);
    await this.#bus.emit('task:failed', { task: task.snapshot(), error });

    // Cascade the skips before any fail-fast sweep, so a dependent of this task
    // settles as "skipped" — naming the dependency that killed it — rather than
    // as a "cancelled" casualty of the sweep that happened to reach it first.
    await this.#applyChanges(entry.mission.refresh(now));

    if (entry.mission.failurePolicy === 'fail-fast') {
      this.#logger.debug('fail-fast: cancelling mission', {
        mission: entry.mission.name,
        task: task.name,
      });
      await this.#cancelEntry(entry, `Fail-fast: task "${task.name}" failed`);
    }
  }

  /**
   * A retry occupies no concurrency slot while it waits — the backoff is a
   * detached timer that re-pumps when it comes due, not a held slot.
   */
  #scheduleRetry(entry: Entry, delayMs: number): void {
    if (delayMs <= 0) {
      this.#pump();
      return;
    }
    this.#waitingRetries += 1;
    void this.#clock.sleep(delayMs, entry.controller.signal).then(
      () => {
        this.#waitingRetries -= 1;
        this.#pump();
        void this.#afterProgress(entry);
      },
      () => {
        // Mission cancelled mid-backoff; the task was already marked cancelled.
        this.#waitingRetries -= 1;
        void this.#afterProgress(entry);
      },
    );
  }

  /** Re-evaluate the graph after any task moved, then settle or keep going. */
  async #afterProgress(entry: Entry): Promise<void> {
    await this.#applyChanges(entry.mission.refresh(this.#clock.now()));

    if (entry.mission.trySettle(this.#clock.now())) {
      this.#entries.delete(entry.mission.id);
      const snapshot = entry.mission.snapshot();
      await this.#emitSettled(entry, snapshot);
      entry.resolve(snapshot);
    }

    this.#pump();
    await this.#checkIdle();
  }

  async #emitSettled(entry: Entry, snapshot: MissionSnapshot): Promise<void> {
    switch (snapshot.state) {
      case 'succeeded':
        await this.#bus.emit('mission:succeeded', { mission: snapshot });
        return;
      case 'failed':
        await this.#bus.emit('mission:failed', { mission: snapshot });
        return;
      case 'cancelled':
        await this.#bus.emit('mission:cancelled', {
          mission: snapshot,
          reason: entry.mission.cancelRequested ? 'Cancelled' : 'Tasks cancelled',
        });
        return;
      default:
        return;
    }
  }

  async #applyChanges(changed: readonly Task[]): Promise<void> {
    for (const task of changed) {
      if (task.state === 'ready') {
        await this.#bus.emit('task:ready', { task: task.snapshot() });
      } else if (task.state === 'skipped') {
        await this.#bus.emit('task:skipped', {
          task: task.snapshot(),
          reason: task.error?.message ?? 'Skipped',
        });
      }
    }
  }

  #isIdle(): boolean {
    if (this.#inFlight.size > 0 || this.#waitingRetries > 0) return false;
    const now = this.#clock.now();
    return [...this.#entries.values()].every(
      (entry) => entry.mission.readyTasks(now).length === 0,
    );
  }

  async #checkIdle(): Promise<void> {
    if (!this.#isIdle()) return;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
    // Announce the edge into idle, not every settle that happens while idle.
    if (this.#idleAnnounced) return;
    this.#idleAnnounced = true;
    await this.#bus.emit('scheduler:idle', { at: this.#clock.now() });
  }
}
