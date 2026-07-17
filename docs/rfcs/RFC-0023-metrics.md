# RFC-0023: Metrics

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| Status        | Implemented                            |
| Date          | 2026-07-18                             |
| Scope         | `packages/metrics` (`@hermes/metrics`) |
| Depends on    | — (zero dependencies)                  |
| Supersedes    | —                                      |
| Superseded by | —                                      |

Design record for metrics: counters, gauges, histograms, and a Prometheus text
formatter.

Covered by 19 tests in `packages/metrics/tests`.

---

## 1. Context

An operator needs to see a running HermesOS: request rates, error counts, queue
depth, latency distributions. That is metrics, and metrics is a small, well-
understood problem — three instrument types and an exposition format — so this
is a **zero-dependency** package rather than a wrapper around `prom-client`,
which would pull a dependency (and its transitive risk) into every service for
what is a few hundred lines of accumulator.

## 2. The three instruments

- **Counter** — monotonic (requests, errors, tokens). Refuses a negative delta,
  because a decreasing counter is a bug the scraper would compute a nonsense
  rate from.
- **Gauge** — up and down (in-flight, depth, memory). `set`/`inc`/`dec`.
- **Histogram** — a distribution into fixed, ascending buckets (latency, size),
  tracking cumulative per-bucket counts plus `sum` and `count`, so percentiles
  are computable without keeping every sample.

All are **labelled**: one metric with `{method, status}` is many time series. A
metric declares its label _names_ up front and each observation supplies
_values_ — the pairing that stops a typo from silently minting a new series. A
label set is keyed canonically (sorted), so `{a,b}` and `{b,a}` are one series,
and an omitted declared label defaults to empty rather than fragmenting the
series.

## 3. Registry and exposition

`MetricsRegistry` is get-or-create: the same name returns the same instrument
(two modules incrementing `http_requests_total` share one series set), and a
name reused with a _different type_ throws — a bug, not a silent second metric.
`snapshot()` reads everything as plain data (for a JSON endpoint or a test) and
`toPrometheus()` renders the standard text format for a `/metrics` scrape,
escaping label values correctly. The registry holds no clock and does no I/O — a
pure accumulator a caller reads on demand, which is what makes every value in
the tests exact.

## 4. Composition

This is the metrics primitive; wiring is a caller's:

- A REST middleware (`@hermes/rest`) times each request and increments the
  counter and histogram — a few lines, not a framework feature.
- A `GET /metrics` handler returns `registry.toPrometheus()`.
- The worker, embedding service, and providers each take a registry and record
  their own counters (jobs processed, tokens billed, retries).

## 5. Testing

Exact-value assertions, no clock: counter inc/read/negative-guard/undeclared-
label/series-keying, gauge set/inc/dec per label, histogram bucketing
(cumulative, sort-on-input, per-label, omitted-label), and the registry
(get-or-create, type conflict, snapshot, Prometheus rendering of
counters/gauges/histograms incl. the `+Inf` bucket, `_sum`, `_count`, HELP
omission, and label escaping). Branch coverage 97%.

## 6. Non-goals

- **No push / no exporters** — this exposes text and structure; a Prometheus
  server scrapes it, or a caller pushes it. Which is a deployment concern.
- **No summaries / quantiles** — histograms cover the need and compute
  percentiles scraper-side; client-side quantile estimation (a summary) is
  heavier and rarely worth it.
- **No auto-instrumentation** — a caller records what matters; magic that meters
  everything produces noise, not insight.
