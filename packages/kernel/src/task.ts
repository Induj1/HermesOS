/**
 * Task — one unit of work, and the state machine that governs it.
 *
 * A Task holds no logic about *how* work gets done. It knows what should be run
 * (a named tool or agent), what it depends on, how many attempts it may have,
 * and where it currently sits in its lifecycle. The scheduler drives it; the
 * task refuses illegal moves.
 *
 * Splitting "what the work is" from "who runs it" is what allows a mission to be
 * inspected, serialised, and reasoned about without executing anything.
 */

import { StateMachine, type TransitionMap } from './lifecycle.js';
import type { MissionId, TaskId } from './ids.js';

/**
 * pending    deps not yet satisfied
 * ready      runnable; waiting for a scheduler slot
 * running    in flight
 * succeeded  produced a result                      (terminal)
 * failed     threw, with no attempts left           (terminal)
 * cancelled  abandoned by mission/runtime shutdown  (terminal)
 * skipped    an upstream task did not succeed       (terminal)
 */
export type TaskState =
  'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

/**
 * `running -> ready` is the retry edge. `failed` is terminal precisely because
 * retries take that edge instead: a task in `failed` has exhausted its attempts,
 * so nothing has to inspect the attempt counter to know whether it is done.
 */
export const TASK_TRANSITIONS = {
  pending: ['ready', 'cancelled', 'skipped'],
  ready: ['running', 'cancelled', 'skipped'],
  running: ['succeeded', 'failed', 'ready', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
} as const satisfies TransitionMap<TaskState>;

const TERMINAL_STATES: readonly TaskState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
];

/** What should run: a tool or an agent, named — never a function reference. */
export type TaskHandlerRef =
  | { readonly kind: 'tool'; readonly name: string }
  | { readonly kind: 'agent'; readonly name: string };

/** The declarative description of a task, as authored in a mission spec. */
export interface TaskSpec {
  /** Unique within its mission. Also how other tasks refer to it in `dependsOn`. */
  readonly name: string;
  readonly handler: TaskHandlerRef;
  readonly input?: unknown;
  /** Names of tasks in the same mission that must succeed first. */
  readonly dependsOn?: readonly string[];
  /** Higher runs first among ready tasks. Default 0. */
  readonly priority?: number;
  /** Total attempts, including the first. Default 1 (no retry). */
  readonly maxAttempts?: number;
  /** Abort the attempt after this long. Default: no limit. */
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A plain-data view of a task. What events carry and what a store would persist. */
export interface TaskSnapshot {
  readonly id: TaskId;
  readonly missionId: MissionId;
  readonly name: string;
  readonly state: TaskState;
  readonly handler: TaskHandlerRef;
  readonly input: unknown;
  readonly dependsOn: readonly string[];
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly startedAt: number | undefined;
  readonly finishedAt: number | undefined;
  readonly result: unknown;
  readonly error: Error | undefined;
}

export interface TaskInit {
  readonly id: TaskId;
  readonly missionId: MissionId;
  readonly spec: TaskSpec;
  readonly createdAt: number;
}

export class Task {
  readonly id: TaskId;
  readonly missionId: MissionId;
  readonly name: string;
  readonly handler: TaskHandlerRef;
  readonly input: unknown;
  readonly dependsOn: readonly string[];
  readonly priority: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;

  readonly #machine: StateMachine<TaskState>;
  #attempts = 0;
  #notBefore = 0;
  #startedAt: number | undefined;
  #finishedAt: number | undefined;
  #result: unknown = undefined;
  #error: Error | undefined;

  constructor(init: TaskInit) {
    const { spec } = init;
    this.id = init.id;
    this.missionId = init.missionId;
    this.name = spec.name;
    this.handler = spec.handler;
    this.input = spec.input;
    this.dependsOn = spec.dependsOn ?? [];
    this.priority = spec.priority ?? 0;
    this.maxAttempts = spec.maxAttempts ?? 1;
    this.timeoutMs = spec.timeoutMs;
    this.metadata = spec.metadata ?? {};
    this.createdAt = init.createdAt;
    this.#machine = new StateMachine<TaskState>('pending', TASK_TRANSITIONS, {
      subject: `task "${spec.name}"`,
    });
  }

  get state(): TaskState {
    return this.#machine.state;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get error(): Error | undefined {
    return this.#error;
  }

  get result(): unknown {
    return this.#result;
  }

  /** Earliest time this task may be dispatched. Non-zero only while retrying. */
  get notBefore(): number {
    return this.#notBefore;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.state);
  }

  /** True if a failure now would still leave an attempt on the table. */
  get canRetry(): boolean {
    return this.#attempts < this.maxAttempts;
  }

  markReady(): void {
    this.#machine.to('ready');
  }

  markRunning(now: number): void {
    this.#machine.to('running');
    this.#attempts += 1;
    this.#startedAt ??= now;
  }

  markSucceeded(result: unknown, now: number): void {
    this.#machine.to('succeeded');
    this.#result = result;
    this.#finishedAt = now;
    this.#error = undefined;
  }

  markFailed(error: Error, now: number): void {
    this.#machine.to('failed');
    this.#error = error;
    this.#finishedAt = now;
  }

  /**
   * Hand the task back to the queue after a failed attempt. The error is kept so
   * an observer can see why the retry is happening; `notBefore` gates backoff.
   */
  markRetrying(error: Error, notBefore: number): void {
    this.#machine.to('ready');
    this.#error = error;
    this.#notBefore = notBefore;
  }

  markCancelled(error: Error, now: number): void {
    this.#machine.to('cancelled');
    this.#error = error;
    this.#finishedAt = now;
  }

  markSkipped(reason: string, now: number): void {
    this.#machine.to('skipped');
    this.#error = new Error(reason);
    this.#finishedAt = now;
  }

  snapshot(): TaskSnapshot {
    return {
      id: this.id,
      missionId: this.missionId,
      name: this.name,
      state: this.state,
      handler: this.handler,
      input: this.input,
      dependsOn: this.dependsOn,
      priority: this.priority,
      attempts: this.#attempts,
      maxAttempts: this.maxAttempts,
      metadata: this.metadata,
      createdAt: this.createdAt,
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      result: this.#result,
      error: this.#error,
    };
  }
}
