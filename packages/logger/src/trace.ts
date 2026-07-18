/**
 * Trace correlation — bind a span's ids onto a logger's records.
 *
 * Kept structural (it takes `{ traceId, spanId }`, not `@hermes/tracing`'s
 * `SpanContext`) so the logger does not depend on the tracing package; a
 * `SpanContext` satisfies it by shape. Once a logger is `child`-bound with these
 * fields, every record it emits carries the trace/span id, so logs and spans
 * line up in a backend without threading ids through every call.
 */

import type { LogFields, Logger } from '@hermes/kernel';

/** The trace/span id fields for a log record. */
export function traceFields(context: {
  readonly traceId: string;
  readonly spanId: string;
}): LogFields {
  return { traceId: context.traceId, spanId: context.spanId };
}

/** A child logger that stamps the trace/span id onto every record. */
export function withTrace(
  logger: Logger,
  context: { readonly traceId: string; readonly spanId: string },
): Logger {
  return logger.child(traceFields(context));
}
