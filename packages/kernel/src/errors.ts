/**
 * Every error the kernel throws on purpose.
 *
 * All of them carry a stable machine-readable `code`. Callers — and, later,
 * services that sit above the kernel — branch on `code`, never on the message,
 * so message wording stays free to change.
 */

export type KernelErrorCode =
  | 'INVALID_TRANSITION'
  | 'MISSION_INVALID'
  | 'DUPLICATE_REGISTRATION'
  | 'NOT_FOUND'
  | 'RUNTIME_STATE'
  | 'PLUGIN_FAILED'
  | 'TASK_TIMEOUT'
  | 'CANCELLED';

/** Base class for kernel-originated errors. */
export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A state machine was asked for a transition its table does not allow. */
export class InvalidTransitionError extends KernelError {
  readonly from: string;
  readonly to: string;

  constructor(subject: string, from: string, to: string) {
    super(
      'INVALID_TRANSITION',
      `${subject} cannot transition from "${from}" to "${to}"`,
    );
    this.from = from;
    this.to = to;
  }
}

/** A mission spec was rejected before it ever ran (bad graph, bad names, ...). */
export class MissionValidationError extends KernelError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('MISSION_INVALID', `Invalid mission: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/** Two things claimed the same name in one registry. */
export class DuplicateRegistrationError extends KernelError {
  constructor(kind: string, name: string) {
    super('DUPLICATE_REGISTRATION', `A ${kind} named "${name}" is already registered`);
  }
}

/** A name was looked up in a registry that has nothing under it. */
export class NotFoundError extends KernelError {
  constructor(kind: string, name: string) {
    super('NOT_FOUND', `No ${kind} named "${name}" is registered`);
  }
}

/** An operation was attempted while the runtime was in the wrong lifecycle state. */
export class RuntimeStateError extends KernelError {
  constructor(message: string) {
    super('RUNTIME_STATE', message);
  }
}

/** A plugin's setup or dispose threw. */
export class PluginError extends KernelError {
  readonly plugin: string;

  constructor(plugin: string, phase: 'setup' | 'dispose', cause: unknown) {
    super('PLUGIN_FAILED', `Plugin "${plugin}" failed during ${phase}`, { cause });
    this.plugin = plugin;
  }
}

/** A task exceeded its `timeoutMs` budget. */
export class TaskTimeoutError extends KernelError {
  readonly timeoutMs: number;

  constructor(taskName: string, timeoutMs: number) {
    super(
      'TASK_TIMEOUT',
      `Task "${taskName}" exceeded its timeout of ${String(timeoutMs)}ms`,
    );
    this.timeoutMs = timeoutMs;
  }
}

/** Work was abandoned because its mission, task, or runtime was cancelled. */
export class CancellationError extends KernelError {
  constructor(reason = 'Cancelled') {
    super('CANCELLED', reason);
  }
}

/**
 * Coerce anything a `throw` produced into an Error.
 *
 * JavaScript lets you throw a string, so every catch block in the kernel funnels
 * through here rather than assuming `catch (e: Error)`.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${safeStringify(thrown)}`, { cause: thrown });
}

function safeStringify(value: unknown): string {
  try {
    // The `??` is not dead code, whatever the lint rule infers from the lib
    // types: JSON.stringify is declared as returning string, but genuinely
    // returns undefined for undefined, a function, or a symbol — all of which
    // can be thrown. The catch covers the other half, cyclic structures.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
