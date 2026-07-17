/**
 * Every error the execution engine throws on purpose.
 *
 * Same contract as the kernel's, the memory service's, and the planner's: a
 * stable machine-readable `code` that callers branch on, so message wording stays
 * free to change (RFC-0001 §5). And, like those, this hierarchy does not extend
 * `KernelError` or `PlannerError` — an execution error that were
 * `instanceof KernelError` would claim the kernel threw it, and the kernel has
 * never heard of this package.
 */

import type { StepError } from './model.js';

export type ExecutionErrorCode =
  | 'INVALID_REFERENCE'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_NOT_FOUND'
  | 'EXECUTION_STATE'
  | 'CHECKPOINT_CORRUPT'
  | 'RECOVERY_EXHAUSTED'
  | 'INVALID_INPUT';

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * A `$from` reference is wrong, or cannot be resolved.
 *
 * Thrown at compile time by `validateRefs` for a reference that names a step
 * that does not exist or is not a declared dependency, and at dispatch by
 * `resolveRefs` for one whose step produced no result. Both name the step,
 * because "cannot resolve reference" without one is unactionable.
 */
export class InvalidReferenceError extends ExecutionError {
  /** The step that was referenced — not, note, the step doing the referencing. */
  readonly step: string;

  constructor(step: string, reason: string) {
    super(
      'INVALID_REFERENCE',
      `Cannot resolve reference to step "${step}": ${reason}.`,
    );
    this.step = step;
  }
}

/**
 * An execution finished without achieving its goal.
 *
 * Carries the failed steps rather than a single cause. Under a `continue`
 * failure policy several steps genuinely fail independently, and reporting only
 * the first would hide the rest — the same argument the kernel makes for
 * `MissionValidationError` carrying every issue.
 */
export class ExecutionFailedError extends ExecutionError {
  readonly executionId: string;
  readonly failures: readonly { readonly step: string; readonly error: StepError }[];

  constructor(
    executionId: string,
    failures: readonly { readonly step: string; readonly error: StepError }[],
  ) {
    super(
      'EXECUTION_FAILED',
      failures.length === 0
        ? `Execution "${executionId}" failed with no step failure recorded, which means ` +
            `the mission was cancelled or the runtime stopped underneath it`
        : `Execution "${executionId}" failed at ${String(failures.length)} step(s): ${failures
            .map((failure) => `${failure.step} (${failure.error.message})`)
            .join('; ')}`,
    );
    this.executionId = executionId;
    this.failures = failures;
  }
}

/** No execution with this id is known to the checkpoint store. */
export class ExecutionNotFoundError extends ExecutionError {
  readonly executionId: string;

  constructor(executionId: string) {
    super('EXECUTION_NOT_FOUND', `No execution named "${executionId}" is stored.`);
    this.executionId = executionId;
  }
}

/**
 * An operation was asked for that this execution's state does not allow.
 *
 * Modelled on the kernel's `InvalidTransitionError` and for the same reason:
 * "resume a running execution" and "pause a finished one" should fail with a
 * clear error naming both states, rather than corrupting one quietly.
 */
export class ExecutionStateError extends ExecutionError {
  readonly executionId: string;
  readonly state: string;

  constructor(executionId: string, state: string, attempted: string) {
    super(
      'EXECUTION_STATE',
      `Cannot ${attempted} execution "${executionId}": it is ${state}.`,
    );
    this.executionId = executionId;
    this.state = state;
  }
}

/**
 * A checkpoint was read back and is not usable.
 *
 * Its own code because the remedy is different from every other failure here:
 * nothing the caller passes is wrong, and retrying will not help. Something
 * wrote a checkpoint this version cannot read, which is an operational problem
 * rather than a programming one.
 */
export class CheckpointCorruptError extends ExecutionError {
  readonly executionId: string;

  constructor(executionId: string, reason: string) {
    super(
      'CHECKPOINT_CORRUPT',
      `Checkpoint for execution "${executionId}" is unusable: ${reason}.`,
    );
    this.executionId = executionId;
  }
}

/**
 * Recovery gave up.
 *
 * An execution that replans, fails, replans, fails is not converging, and the
 * useful thing to do is stop and say so rather than burn the budget discovering
 * it slowly. Carries the attempt count so the operator can tell "the limit is
 * too low" from "this will never work".
 */
export class RecoveryExhaustedError extends ExecutionError {
  readonly executionId: string;
  readonly attempts: number;

  constructor(executionId: string, attempts: number, reason: string) {
    super(
      'RECOVERY_EXHAUSTED',
      `Execution "${executionId}" gave up after ${String(attempts)} attempt(s): ${reason}.`,
    );
    this.executionId = executionId;
    this.attempts = attempts;
  }
}

/** Input was rejected at the engine's boundary. */
export class InvalidInputError extends ExecutionError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('INVALID_INPUT', `Invalid input: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/**
 * Coerce anything thrown into an `Error`.
 *
 * Each layer keeps its own rather than importing the kernel's: every catch block
 * here would otherwise depend on the kernel to handle an error the kernel did
 * not throw — a coupling with no payoff.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}

/**
 * Reduce an error to something a checkpoint can hold.
 *
 * `JSON.stringify(new Error('boom'))` is `'{}'`, so a checkpoint storing the raw
 * error would record that every failure had no cause. `@hermes/memory` solves
 * this for the audit log with `flattenError`; this is the same fix for the same
 * reason, kept local because the shape this needs is smaller and the two must be
 * free to diverge.
 */
export function toStepError(thrown: unknown): StepError {
  const error = toError(thrown);
  const code = (error as { code?: unknown }).code;

  return {
    name: error.name,
    message: error.message,
    // The kernel's stable code, when it threw one. What callers branch on, and
    // the field most worth surviving a message rewording (RFC-0001 §5).
    ...(typeof code === 'string' ? { code } : {}),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
