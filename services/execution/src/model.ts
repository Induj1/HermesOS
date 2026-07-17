/**
 * The execution engine's domain types — plain, serialisable data.
 *
 * An {@link Execution} is to a {@link Plan} what a kernel `Mission` is to a
 * `MissionSpec`: the running instance of a static description. It is a distinct
 * type from both, and the reason is the same one the planner gives for `Plan`
 * not being `MissionSpec` — it carries what the layer below refuses to know.
 *
 * The kernel knows a mission's tasks succeeded. It does not know that step `b`
 * consumed step `a`'s output, that the execution was resumed from a checkpoint
 * after a crash, or that three of its steps came from a replan of an earlier
 * attempt. Those are execution concepts, they are what this service exists to
 * own, and they live here.
 *
 * Conventions inherited rather than invented: timestamps are epoch milliseconds
 * from an injected `Clock`, ids are branded opaque strings the way the kernel's
 * are, and everything here survives `JSON.stringify` — which is not decoration.
 * A checkpoint that cannot be serialised cannot be resumed after the process
 * that wrote it has died, which is the only case a checkpoint is for.
 */

import type { Brand, FailurePolicy, MissionId } from '@hermes/kernel';
import type { CapabilityRef, Goal, PlanId } from '@hermes/planner';

export type ExecutionId = Brand<string, 'ExecutionId'>;

export function toExecutionId(raw: string): ExecutionId {
  return raw as ExecutionId;
}

/**
 * Where an execution is in its life.
 *
 * Deliberately *not* the kernel's `MissionState`, though it looks similar. Two
 * of these states have no kernel equivalent and are the whole reason this
 * machine exists:
 *
 * - `paused` — the kernel has no pause. A mission runs to settlement or is
 *   cancelled; there is no state to come back from (RFC-0001 §11.3). Pause is an
 *   *execution* concept implemented as cancel-and-checkpoint, and this is the
 *   state that records it happened on purpose rather than by failure.
 * - `recovering` — a settled mission is being succeeded by another, which from
 *   the kernel's side is simply two unrelated missions. From here it is one
 *   execution that stumbled.
 */
export type ExecutionState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'recovering'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Terminal states. An execution in one of these is never run again. */
export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * Where a single step is in its life.
 *
 * Mirrors the kernel's `TaskState` minus `ready`, which is a scheduler concept:
 * "ready" means the scheduler could dispatch it, and the engine does not
 * schedule. A step the engine has handed to the kernel is `running` as far as
 * the engine is concerned, whether or not a slot was free.
 */
export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/**
 * What happened to one step, across every attempt at it.
 *
 * `result` is the value the capability returned, and it is the thing `$from`
 * references resolve against — so this record is not merely an audit trail, it
 * is load-bearing state. That is why it is serialisable and why it is what gets
 * checkpointed.
 */
export interface StepRecord {
  readonly name: string;
  /** The real capability, not the envelope the kernel dispatched. See `compiler/`. */
  readonly capability: CapabilityRef;
  readonly state: StepState;
  /** Why this step exists, carried from the plan for humans reading history. */
  readonly intent: string;
  /** Total attempts made, across the kernel's retries. 0 if it never started. */
  readonly attempts: number;
  /** What the capability returned. Only meaningful when `state` is `succeeded`. */
  readonly result?: unknown;
  /** Why it failed, flattened. A live `Error` does not survive a checkpoint. */
  readonly error?: StepError;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

/**
 * A failure, reduced to something that survives `JSON.stringify`.
 *
 * `JSON.stringify(new Error('boom'))` is `'{}'` — name, message and stack are
 * non-enumerable. A checkpoint that stored the raw error would faithfully record
 * that every failure had no cause. `@hermes/memory` solves the same problem for
 * the same reason with `flattenError`, and this type is deliberately shaped to
 * match its `FlatError` so the two can be read together.
 */
export interface StepError {
  readonly name: string;
  readonly message: string;
  /** The kernel's stable error code, when it threw one. What callers branch on. */
  readonly code?: string;
  readonly stack?: string;
}

/**
 * A complete, inspectable view of an execution. What `execute` resolves to.
 *
 * The engine's answer to `MissionSnapshot`, and like it, a value: nothing here
 * is live, nothing mutates under the reader, and the whole of it can be logged,
 * diffed, stored, or handed to a human.
 */
export interface ExecutionSnapshot {
  readonly id: ExecutionId;
  readonly planId: PlanId;
  readonly goal: Goal;
  readonly state: ExecutionState;
  readonly steps: readonly StepRecord[];
  /**
   * Every kernel mission this execution has run, oldest first.
   *
   * A list rather than one id, because recovery means a settled mission is
   * *succeeded by another* (RFC-0001 §11.3) — so one execution legitimately
   * spans several missions, and collapsing that to "the mission id" would lose
   * the attempt that failed, which is the one worth reading.
   */
  readonly missions: readonly MissionId[];
  readonly failurePolicy: FailurePolicy;
  /** How many times this execution has been replanned. Bounded; see `RecoveryPolicy`. */
  readonly attempts: number;
  readonly createdAt: number;
  readonly finishedAt?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Everything needed to resume an execution in a process that never saw it start.
 *
 * This is the sharpest constraint on the whole design, and it is worth being
 * explicit about: **a checkpoint is only useful if it outlives the process**.
 * Anything unserialisable in here — a live `Error`, a class instance, a closure,
 * an `AbortSignal` — makes resume-after-crash a lie that only shows up in
 * production. So a checkpoint is a `StepRecord[]` and scalars, and nothing else.
 *
 * The plan is carried whole rather than by id. Resume must not depend on a plan
 * store existing, on the strategy that produced it still being registered, or on
 * a model being awake to produce it again — and re-planning on resume would
 * produce a *different* plan, which is not a resume at all.
 */
export interface ExecutionCheckpoint {
  readonly id: ExecutionId;
  readonly state: ExecutionState;
  /** The plan being executed, carried whole. See above. */
  readonly plan: SerialisablePlan;
  readonly steps: readonly StepRecord[];
  readonly missions: readonly MissionId[];
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * The subset of a `Plan` a checkpoint stores.
 *
 * Structurally a `Plan`, and deliberately re-declared rather than imported as
 * one. A `Plan` is the planner's type and the planner may extend it; a
 * checkpoint is a persistence format and must be able to read what an older
 * version wrote. Naming the shape here is what stops a planner change from
 * silently invalidating every checkpoint on disk.
 */
export interface SerialisablePlan {
  readonly id: PlanId;
  readonly goal: Goal;
  readonly steps: readonly SerialisableStep[];
  readonly strategy: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SerialisableStep {
  readonly name: string;
  readonly intent: string;
  readonly capability: CapabilityRef;
  readonly input?: unknown;
  readonly dependsOn?: readonly string[];
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly optional?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
