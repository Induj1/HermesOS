/**
 * Sinks and formatting — where records go and how they are rendered.
 *
 * `formatJsonLine` is the canonical rendering: a single JSON object per line
 * (the shape every log aggregator ingests), with a stable key order —
 * `time`, `level`, `msg`, then the fields. It is a pure function, and because it
 * serializes with `JSON.stringify`, a `@hermes/secrets` `Secret` in a field
 * renders as `[redacted]` for free.
 */

import type { LogRecord } from './logger.js';

const RESERVED = new Set(['time', 'level', 'msg']);

/** Render a record as a single JSON line (no trailing newline). */
export function formatJsonLine(record: LogRecord): string {
  // Core keys first and always the same shape: a field that reuses `time`,
  // `level`, or `msg` is dropped rather than allowed to shadow the core key, so
  // every line parses identically.
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    if (!RESERVED.has(key)) safe[key] = value;
  }
  return JSON.stringify({
    time: record.timeMs,
    level: record.level,
    msg: record.message,
    ...safe,
  });
}

/** A sink that keeps records in memory — the test double. */
export class MemorySink {
  readonly #records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.#records.push(record);
  }

  /** Every record written so far, in order. */
  get records(): readonly LogRecord[] {
    return this.#records;
  }

  /** Render everything as JSON lines — handy for assertions. */
  lines(): readonly string[] {
    return this.#records.map(formatJsonLine);
  }

  /** Drop all records. */
  reset(): void {
    this.#records.length = 0;
  }
}

/** A sink that writes JSON lines through an injected writer (no direct stdout). */
export function jsonLinesSink(write: (line: string) => void): {
  write(record: LogRecord): void;
} {
  return {
    write: (record) => {
      write(formatJsonLine(record));
    },
  };
}
