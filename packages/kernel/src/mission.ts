/**
 * Mission — a goal, expressed as a DAG of tasks.
 *
 * A mission is the kernel's unit of intent. It owns the dependency graph and all
 * the rules that follow from it: which tasks are runnable now, which must be
 * skipped because something upstream died, and when the whole thing is done.
 *
 * All of that is pure. `refresh()` takes a timestamp and returns the tasks whose
 * state changed; it emits nothing and awaits nothing. The scheduler decides what
 * to announce and what to run. That separation is why mission logic — the
 * fiddliest part of the kernel — is testable without a scheduler, a clock, or a
 * bus.
 */

import { MissionValidationError } from './errors.js';
import { topoSort } from './graph.js';
import { StateMachine, type TransitionMap } from './lifecycle.js';
import { Task, type TaskSnapshot, type TaskSpec } from './task.js';
import { toMissionId, toTaskId, type IdGenerator, type MissionId } from './ids.js';

export type MissionState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const MISSION_TRANSITIONS = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionMap<MissionState>;

/**
 * What to do with the rest of the mission when one task fails for good.
 *
 * `fail-fast`  — abandon everything still outstanding. Right when tasks share a
 *                goal and a partial result is worthless.
 * `continue`   — only the failed task's dependents are skipped; independent
 *                branches run to completion. Right for fan-out work where each
 *                branch stands alone.
 */
export type FailurePolicy = 'fail-fast' | 'continue';

export interface MissionSpec {
  readonly name: string;
  /** Human-readable statement of intent. Carried, never interpreted. */
  readonly goal?: string;
  readonly tasks: readonly TaskSpec[];
  readonly failurePolicy?: FailurePolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MissionSnapshot {
  readonly id: MissionId;
  readonly name: string;
  readonly goal: string | undefined;
  readonly state: MissionState;
  readonly failurePolicy: FailurePolicy;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly finishedAt: number | undefined;
  readonly tasks: readonly TaskSnapshot[];
}

export interface MissionDeps {
  readonly ids: IdGenerator;
  readonly now: number;
}

export class Mission {
  readonly id: MissionId;
  readonly name: string;
  readonly goal: string | undefined;
  readonly failurePolicy: FailurePolicy;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;

  readonly #tasks: readonly Task[];
  readonly #byName: ReadonlyMap<string, Task>;
  readonly #machine: StateMachine<MissionState>;
  #cancelRequested = false;
  #finishedAt: number | undefined;

  private constructor(spec: MissionSpec, deps: MissionDeps) {
    this.id = toMissionId(deps.ids('mission'));
    this.name = spec.name;
    this.goal = spec.goal;
    this.failurePolicy = spec.failurePolicy ?? 'fail-fast';
    this.metadata = spec.metadata ?? {};
    this.createdAt = deps.now;
    this.#tasks = spec.tasks.map(
      (taskSpec) =>
        new Task({
          id: toTaskId(deps.ids('task')),
          missionId: this.id,
          spec: taskSpec,
          createdAt: deps.now,
        }),
    );
    this.#byName = new Map(this.#tasks.map((task) => [task.name, task]));
    this.#machine = new StateMachine<MissionState>('pending', MISSION_TRANSITIONS, {
      subject: `mission "${spec.name}"`,
    });
  }

  /**
   * Validate and build. Throws {@link MissionValidationError} listing every
   * problem at once — an author fixing a spec wants all the issues, not the
   * first one, then the second one on the next run.
   */
  static create(spec: MissionSpec, deps: MissionDeps): Mission {
    const issues = validate(spec);
    if (issues.length > 0) throw new MissionValidationError(issues);
    return new Mission(spec, deps);
  }

  get state(): MissionState {
    return this.#machine.state;
  }

  get tasks(): readonly Task[] {
    return this.#tasks;
  }

  get isSettled(): boolean {
    return this.#machine.isFinal;
  }

  get cancelRequested(): boolean {
    return this.#cancelRequested;
  }

  taskByName(name: string): Task | undefined {
    return this.#byName.get(name);
  }

  /** Tasks that could be dispatched right now, best first. */
  readyTasks(now: number): readonly Task[] {
    return this.#tasks
      .filter((task) => task.state === 'ready' && task.notBefore <= now)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt - b.createdAt ||
          a.name.localeCompare(b.name),
      );
  }

  /** Move to `running`. Idempotent, so a scheduler need not track whether it started. */
  start(): boolean {
    return this.#machine.tryTo('running');
  }

  /**
   * Recompute the graph and return every task whose state changed.
   *
   * Promotes `pending -> ready` when all dependencies succeeded, and
   * `pending -> skipped` when any dependency did not (and never will).
   *
   * Runs to a fixed point, because skipping cascades: marking `b` skipped is
   * what makes `c`, which depends on `b`, skippable. A single pass would leave
   * `c` pending until some unrelated event happened to trigger another refresh —
   * and if none ever did, the mission would hang instead of settling.
   */
  refresh(now: number): readonly Task[] {
    const changed: Task[] = [];
    let progressed = true;

    while (progressed) {
      progressed = false;
      for (const task of this.#tasks) {
        if (task.state !== 'pending') continue;

        const deps = task.dependsOn.map((name) => this.#byName.get(name));
        const blocker = deps.find(
          (dep) => dep !== undefined && dep.isTerminal && dep.state !== 'succeeded',
        );
        if (blocker) {
          task.markSkipped(`Dependency "${blocker.name}" ${blocker.state}`, now);
          changed.push(task);
          progressed = true;
          continue;
        }

        if (deps.every((dep) => dep?.state === 'succeeded')) {
          task.markReady();
          changed.push(task);
          progressed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Mark every not-yet-started task cancelled and record the intent.
   *
   * Running tasks are not touched — they are aborted through their signal by
   * whoever owns the controller, and report their own cancellation when they
   * unwind.
   */
  requestCancel(reason: string, now: number): readonly Task[] {
    this.#cancelRequested = true;
    const changed: Task[] = [];
    for (const task of this.#tasks) {
      if (task.state === 'pending' || task.state === 'ready') {
        task.markCancelled(new Error(reason), now);
        changed.push(task);
      }
    }
    return changed;
  }

  /** True once no task can make further progress. */
  get isComplete(): boolean {
    return this.#tasks.every((task) => task.isTerminal);
  }

  get hasFailure(): boolean {
    return this.#tasks.some((task) => task.state === 'failed');
  }

  /**
   * Settle the mission if every task is terminal. Returns whether it settled.
   *
   * A failure outranks a cancellation: if any task failed, the mission failed,
   * even if a fail-fast cancellation swept up the rest. The cause of death is
   * more useful than its mechanism.
   */
  trySettle(now: number): boolean {
    if (this.isSettled || !this.isComplete) return false;
    const outcome: MissionState = this.hasFailure
      ? 'failed'
      : this.#tasks.every((task) => task.state === 'succeeded')
        ? 'succeeded'
        : 'cancelled';
    this.#machine.tryTo('running');
    this.#machine.to(outcome);
    this.#finishedAt = now;
    return true;
  }

  snapshot(): MissionSnapshot {
    return {
      id: this.id,
      name: this.name,
      goal: this.goal,
      state: this.state,
      failurePolicy: this.failurePolicy,
      metadata: this.metadata,
      createdAt: this.createdAt,
      finishedAt: this.#finishedAt,
      tasks: this.#tasks.map((task) => task.snapshot()),
    };
  }
}

function validate(spec: MissionSpec): string[] {
  const issues: string[] = [];
  if (spec.name.trim() === '') issues.push('mission name must not be empty');
  if (spec.tasks.length === 0) issues.push('mission must have at least one task');

  for (const task of spec.tasks) {
    if (task.name.trim() === '') issues.push('task name must not be empty');
    if (task.maxAttempts !== undefined && task.maxAttempts < 1) {
      issues.push(`task "${task.name}": maxAttempts must be at least 1`);
    }
    if (task.timeoutMs !== undefined && task.timeoutMs <= 0) {
      issues.push(`task "${task.name}": timeoutMs must be positive`);
    }
    if (task.dependsOn?.includes(task.name) === true) {
      issues.push(`task "${task.name}" depends on itself`);
    }
  }

  const sorted = topoSort(
    spec.tasks.map((task) => ({ id: task.name, dependsOn: task.dependsOn ?? [] })),
  );
  if (!sorted.ok) {
    if (sorted.reason === 'duplicate')
      issues.push(`duplicate task name "${sorted.id}"`);
    else if (sorted.reason === 'missing') {
      issues.push(`task "${sorted.from}" depends on unknown task "${sorted.missing}"`);
    } else issues.push(`dependency cycle: ${sorted.cycle.join(' -> ')}`);
  }

  return issues;
}
