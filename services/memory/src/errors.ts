/**
 * Every error the memory service throws on purpose.
 *
 * Same contract as the kernel's errors (RFC-0001 §5): a stable machine-readable
 * `code` that callers branch on, so message wording stays free to change. The
 * class hierarchy is deliberately separate from `KernelError` rather than
 * extending it — the memory service depends on the kernel's public interfaces,
 * and a `MemoryError` that were `instanceof KernelError` would claim the kernel
 * threw it, which is exactly backwards: nothing in the kernel knows this service
 * exists.
 */

export type MemoryErrorCode =
  | 'MIGRATION_FAILED'
  | 'MIGRATION_DRIFT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'EMBEDDING_FAILED'
  | 'DIMENSION_MISMATCH'
  | 'UNSUPPORTED';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * A migration threw. Carries the file so the failure names itself.
 *
 * The cause's message is folded into this one rather than left only on `cause`.
 * A bare `Migration "0002_memory.sql" failed` is the least useful sentence a
 * migration runner can produce — whether the reason surfaces would depend on
 * whether whatever caught it happens to print cause chains, and most log lines
 * do not.
 */
export class MigrationFailedError extends MemoryError {
  readonly migration: string;

  constructor(migration: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super('MIGRATION_FAILED', `Migration "${migration}" failed: ${reason}`, { cause });
    this.migration = migration;
  }
}

/**
 * An applied migration's file has changed since it ran.
 *
 * Never a warning. The database in front of you is not the database this code
 * expects, and every query written against the new file is now a guess.
 */
export class MigrationDriftError extends MemoryError {
  readonly migration: string;

  constructor(migration: string, expected: string, actual: string) {
    super(
      'MIGRATION_DRIFT',
      `Migration "${migration}" has changed since it was applied ` +
        `(recorded checksum ${expected.slice(0, 12)}, file checksum ${actual.slice(0, 12)}). ` +
        `Applied migrations are immutable: add a new migration instead. ` +
        `If the change is known-safe and the database already matches, ` +
        `re-run with HERMES_MIGRATE_REPAIR=1 to re-apply and re-record it.`,
    );
    this.migration = migration;
  }
}

/** A row was looked up by an id that is not there. */
export class MemoryNotFoundError extends MemoryError {
  readonly kind: string;
  readonly id: string;

  constructor(kind: string, id: string) {
    super('NOT_FOUND', `No ${kind} with id "${id}"`);
    this.kind = kind;
    this.id = id;
  }
}

/** A write lost a race, or violated a uniqueness rule. */
export class MemoryConflictError extends MemoryError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFLICT', message, options);
  }
}

/** Input was rejected before it reached the database. */
export class InvalidInputError extends MemoryError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('INVALID_INPUT', `Invalid input: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/** An embedding provider failed to produce vectors. */
export class EmbeddingFailedError extends MemoryError {
  readonly model: string;

  constructor(model: string, message: string, options?: ErrorOptions) {
    super('EMBEDDING_FAILED', `Embedding with "${model}" failed: ${message}`, options);
    this.model = model;
  }
}

/**
 * A vector's length disagrees with what it was compared against.
 *
 * Worth its own code because the failure it prevents is silent: cosine
 * similarity over mismatched vectors returns a plausible number rather than an
 * error, so this must be caught at the boundary or not at all.
 */
export class DimensionMismatchError extends MemoryError {
  readonly expected: number;
  readonly actual: number;

  constructor(context: string, expected: number, actual: number) {
    super(
      'DIMENSION_MISMATCH',
      `${context}: expected ${String(expected)} dimensions, got ${String(actual)}`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/** The backing store cannot do what was asked (e.g. pgvector query, no pgvector). */
export class UnsupportedError extends MemoryError {
  constructor(message: string) {
    super('UNSUPPORTED', message);
  }
}

/**
 * Coerce anything a `throw` produced into an Error.
 *
 * The kernel exports `toError` for exactly this, and this service could import
 * it — but a re-export would make every catch block here depend on the kernel to
 * handle a `pg` error, which is a coupling with no payoff. Six lines is cheaper
 * than the dependency edge.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}
