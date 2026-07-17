# @hermes/metrics

Zero-dependency metrics — counters, gauges, histograms, and a Prometheus text
formatter.

- **Design record:** [RFC-0023](../../docs/rfcs/RFC-0023-metrics.md).
- **Depends on:** nothing.

## Usage

```ts
import { MetricsRegistry } from '@hermes/metrics';

const metrics = new MetricsRegistry();
const requests = metrics.counter('http_requests_total', 'HTTP requests', [
  'method',
  'status',
]);
const inflight = metrics.gauge('http_inflight', 'in-flight requests');
const latency = metrics.histogram(
  'http_latency_seconds',
  [0.01, 0.1, 1, 10],
  'latency',
  ['route'],
);

requests.inc({ method: 'GET', status: '200' });
inflight.inc();
latency.observe(0.042, { route: '/missions' });
inflight.dec();

// GET /metrics
response.body = metrics.toPrometheus();
```

## The three instruments

- **Counter** — monotonic; `inc(labels?, by?)`; refuses a negative delta.
- **Gauge** — up/down; `set` / `inc` / `dec`.
- **Histogram** — a distribution into fixed ascending buckets;
  `observe(value, labels?)`; tracks cumulative bucket counts, `sum`, and
  `count`.

All are **labelled**: a metric declares its label names, each observation
supplies values, and a label set is keyed canonically so ordering never
fragments a series.

## Registry

`counter` / `gauge` / `histogram` are get-or-create (same name → same
instrument; a name reused with a different type throws). `snapshot()` returns
plain data; `toPrometheus()` renders the standard exposition format. No clock,
no I/O — a pure accumulator, so tests assert exact values and a scrape is a
plain read.

## Composition

Wiring is the caller's: a REST middleware times each request into a counter +
histogram, a `GET /metrics` handler returns `toPrometheus()`, and each subsystem
records its own counters (jobs processed, tokens billed, retries). See RFC-0023
§4.
