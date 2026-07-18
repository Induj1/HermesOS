/**
 * @hermes/tracing — Deterministic distributed tracing.
 *
 * ```ts
 * const exporter = new InMemorySpanExporter();
 * const tracer = new Tracer({ clock: systemClock, ids: randomIdGenerator(), exporter });
 *
 * // Continue an inbound trace, or start a fresh one:
 * const parent = parseTraceparent(req.headers['traceparent'] ?? '');
 * await tracer.withSpan('GET /missions', async (span) => {
 *   span.setAttribute('http.method', 'GET');
 *   // propagate downstream:
 *   fetch(url, { headers: { traceparent: formatTraceparent(span.context()) } });
 * }, { parent });
 * ```
 *
 * Timing and ids are injected, so under test a `TestClock` and
 * `sequentialIdGenerator` make every span exact and reproducible.
 */

export { formatTraceparent, parseTraceparent, type SpanContext } from './context.js';

export { sequentialIdGenerator, type IdGenerator } from './ids.js';

export {
  InMemorySpanExporter,
  Span,
  type Attributes,
  type AttributeValue,
  type FinishedSpan,
  type SpanEvent,
  type SpanExporter,
  type SpanStatus,
} from './span.js';

export { Tracer, type StartSpanOptions, type TracerOptions } from './tracer.js';

export { randomIdGenerator } from './node.js';
