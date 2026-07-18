/**
 * Structured logging — the observability signal that carries context.
 *
 * `StructuredLogger` implements the kernel's `Logger` contract (`debug`/`info`/
 * `warn`/`error` + `child`) and emits a `LogRecord` per call: a level, a
 * message, a timestamp from an injected `Clock`, and a merged field bag. Records
 * go to an injected `LogSink`, so where they land (a JSON line to stdout, a test
 * buffer, a network shipper) is a choice the host makes — this module does no
 * I/O and reads no wall clock, which is what makes it testable to the record.
 *
 * Three properties make it useful in production:
 *
 * - **Levels filter cheaply.** A record below the configured level is dropped
 *   before the sink, so `debug` logging left in place costs a comparison.
 * - **`child` binds context.** `logger.child({ requestId })` stamps that field
 *   onto every downstream record, which is how one request's logs are
 *   correlated — and how a trace id (`traceFields`) threads through.
 * - **Secrets stay redacted.** A `@hermes/secrets` `Secret` in a field serializes
 *   as `[redacted]` (its `toJSON`), so context can be logged without leaking a
 *   key — no allowlist to maintain.
 */

import type { Clock, LogFields, Logger } from '@hermes/kernel';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One structured log line. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timeMs: number;
  /** The bound (`child`) fields merged with the per-call fields. */
  readonly fields: LogFields;
}

/** Where records go. The seam to stdout, a file, a shipper, or a test buffer. */
export interface LogSink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly clock: Clock;
  /** The minimum level to emit (default `info`). */
  readonly level?: LogLevel;
  /** Fields stamped onto every record from this logger. */
  readonly fields?: LogFields;
}

export class StructuredLogger implements Logger {
  readonly #sink: LogSink;
  readonly #clock: Clock;
  readonly #level: LogLevel;
  readonly #fields: LogFields;

  constructor(options: LoggerOptions) {
    this.#sink = options.sink;
    this.#clock = options.clock;
    this.#level = options.level ?? 'info';
    this.#fields = options.fields ?? {};
  }

  /** The minimum level this logger emits. */
  get level(): LogLevel {
    return this.#level;
  }

  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields);
  }

  /** A logger that stamps `fields` (merged over this logger's) onto every record. */
  child(fields: LogFields): Logger {
    return new StructuredLogger({
      sink: this.#sink,
      clock: this.#clock,
      level: this.#level,
      fields: { ...this.#fields, ...fields },
    });
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    if (RANK[level] < RANK[this.#level]) return;
    this.#sink.write({
      level,
      message,
      timeMs: this.#clock.now(),
      fields: fields === undefined ? this.#fields : { ...this.#fields, ...fields },
    });
  }
}

/** Whether `level` would be emitted at minimum level `min`. */
export function isLevelEnabled(level: LogLevel, min: LogLevel): boolean {
  return RANK[level] >= RANK[min];
}
