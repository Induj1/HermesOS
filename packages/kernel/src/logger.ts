/**
 * The logging shape the kernel expects.
 *
 * Deliberately re-declared here rather than imported from `@hermes/logger`: the
 * kernel has zero workspace dependencies, and this interface is small enough
 * that any structured logger satisfies it structurally. The host injects a real
 * one; the default discards.
 */

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Return a logger that stamps `fields` onto every record. */
  child(fields: LogFields): Logger;
}

/** Drops everything. The default, so the kernel is silent unless asked. */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
