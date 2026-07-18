/**
 * Trace and span id generation.
 *
 * An `IdGenerator` mints the two id widths a trace needs — a 32-hex trace id and
 * a 16-hex span id. It is injected into the `Tracer` so tests get **stable,
 * predictable ids** from `sequentialIdGenerator` (assert on `span-0000…0001`
 * rather than a random string), while production uses the cryptographically
 * random generator in `node.ts`.
 */

export interface IdGenerator {
  /** A 32-lowercase-hex trace id. */
  traceId(): string;
  /** A 16-lowercase-hex span id. */
  spanId(): string;
}

/**
 * A deterministic generator: monotonically increasing counters rendered as hex.
 * Trace ids and span ids count independently, both starting at 1 (never the
 * all-zero id, which the `traceparent` format forbids). For tests only.
 */
export function sequentialIdGenerator(): IdGenerator {
  let trace = 0;
  let span = 0;
  return {
    traceId: () => {
      trace += 1;
      return trace.toString(16).padStart(32, '0');
    },
    spanId: () => {
      span += 1;
      return span.toString(16).padStart(16, '0');
    },
  };
}
