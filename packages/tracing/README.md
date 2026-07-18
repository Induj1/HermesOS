# @hermes/tracing

Deterministic distributed tracing — spans, W3C `traceparent` propagation, and
pluggable exporters.

- **Design record:** [RFC-0027](../../docs/rfcs/RFC-0027-tracing.md).
- **Depends on:** `@hermes/kernel` (the `Clock`).

## Usage

```ts
import { systemClock } from '@hermes/kernel';
import {
  InMemorySpanExporter,
  Tracer,
  formatTraceparent,
  parseTraceparent,
  randomIdGenerator,
} from '@hermes/tracing';

const exporter = new InMemorySpanExporter();
const tracer = new Tracer({
  clock: systemClock,
  ids: randomIdGenerator(),
  exporter,
});

// Continue an inbound trace (or start fresh if the header is absent/corrupt):
const parent = parseTraceparent(request.headers.traceparent ?? '');

await tracer.withSpan(
  'GET /missions',
  async (span) => {
    span.setAttribute('http.method', 'GET');
    // Propagate downstream:
    await fetch(url, {
      headers: { traceparent: formatTraceparent(span.context()) },
    });
  },
  { parent },
);

exporter.spans; // [{ name: 'GET /missions', durationMs, status, ... }]
```

## Concepts

- **Span identity.** `SpanContext` = trace id + span id + sampled. A root span
  gets a fresh trace id; a child inherits the trace id and sampled flag and
  records the parent span id.
- **Propagation.** `formatTraceparent` / `parseTraceparent` speak the W3C
  header, so traces interoperate with any OpenTelemetry backend. A malformed
  header parses to `undefined` (start a fresh trace, never a bogus parent).
- **Lifecycle safety.** `end()` is idempotent and recording after `end()` is a
  no-op — a late callback can't corrupt or double-export a span.
- **`withSpan`.** Runs a function inside a span, ending it in `finally` and
  recording a thrown error as `error` status. The span can't be left un-ended.
- **Determinism.** Ids and time are injected; tests use `sequentialIdGenerator`
  and a `TestClock` for exact, reproducible spans.
