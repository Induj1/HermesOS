/**
 * Span context and W3C `traceparent` propagation.
 *
 * A `SpanContext` is the minimal identity a trace carries across a boundary: the
 * trace it belongs to, the current span, and whether it is sampled. To cross a
 * process boundary (an HTTP call to another service, a provider request) it is
 * serialized as a **W3C `traceparent`** header — the one interoperable format,
 * so a Hermes trace stitches into any OpenTelemetry-aware backend without a
 * bespoke wire format.
 *
 * `traceparent = version "-" trace-id "-" parent-id "-" trace-flags`, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
 */

export interface SpanContext {
  /** 16 bytes, 32 lowercase hex. Never all-zero. */
  readonly traceId: string;
  /** 8 bytes, 16 lowercase hex. Never all-zero. */
  readonly spanId: string;
  /** The sampled flag (bit 0 of trace-flags). */
  readonly sampled: boolean;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** Serialize a context as a `traceparent` header value. */
export function formatTraceparent(context: SpanContext): string {
  const flags = context.sampled ? '01' : '00';
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * Parse a `traceparent` header. Returns `undefined` for anything malformed — an
 * unknown version, a bad length, a non-hex char, or an all-zero id — so a
 * corrupt inbound header starts a fresh trace rather than poisoning one.
 */
export function parseTraceparent(header: string): SpanContext | undefined {
  const match = TRACEPARENT.exec(header.trim());
  if (match === null) return undefined;
  // The pattern has three capture groups, so a match always fills all three.
  const [, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  // Sampled is bit 0 of the flags byte.
  const sampled = (parseInt(flags, 16) & 0x01) === 0x01;
  return { traceId, spanId, sampled };
}
