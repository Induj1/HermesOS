# RFC-0035: Load Testing

| Field      | Value                                    |
| ---------- | ---------------------------------------- |
| Status     | Implemented                              |
| Date       | 2026-07-18                               |
| Scope      | `packages/loadtest` (`@hermes/loadtest`) |
| Depends on | `@hermes/kernel`, `@hermes/metrics`      |
| Milestone  | Production #39                           |

Design record for the deterministic in-process load harness (Production
milestone #39).

Covered by 14 tests in `packages/loadtest/tests`.

---

## 1. Context

Milestone #39 asks for a way to measure throughput and latency under
concurrency. The trap is a load tool that is itself a source of non-determinism
(real timers, real network) and so cannot be unit-tested or reproduced. This
harness avoids that: `runLoad` is a **pure function of
`(count, concurrency, clock, operation)`**. The same code measures a real target
under `systemClock` and produces exact, reproducible numbers under a `TestClock`
— which is what lets the harness itself have 100% coverage and a deterministic
test suite.

It drives the existing subsystems through their **ports**: an `operation` that
issues a request against the REST `Application` or enqueues-and-drains a job on
the `Worker`. The harness knows nothing about either — it runs a callback — so
it stays a thin, reusable driver rather than a REST- or worker-specific tool.

## 2. The harness

`runLoad` runs `operation` `count` times through a pool of at most `concurrency`
workers. Each worker pulls the next index, times the call with the injected
`Clock`, and records the latency; a thrown operation is a **failure that still
contributes its latency**, because a timeout or error has a duration and hiding
it would flatter the report. The pool size is capped at `count` (no idle
workers), and a zero-count run is valid (an empty report).

The `LoadReport` carries the count, successes, failures, wall time, throughput
(`count / wallSeconds`), and a latency summary. Throughput falls back to `count`
when no time passed, so a synchronous operation under a `TestClock` does not
divide by zero.

## 3. Statistics

`summarize` reports **percentiles, not just the mean** — p50/p90/p99, plus
min/max/mean — because under load it is the tail (p99) that hurts, and an
average hides it. Percentiles are nearest-rank (`percentile(sorted, 90)` is the
value at rank `ceil(0.9·n)`), which is unambiguous and needs no interpolation
policy. An empty sample summarizes to zeros rather than `NaN`.

## 4. Metrics integration

`runLoad` optionally observes each latency into a `@hermes/metrics` `Histogram`
(milestone #39's "use the histograms already built"), so a run's distribution
lands in the same instrument a live service exposes on `/metrics` — the load
result and the production metric are the same shape, comparable directly.

## 5. Determinism model

Under a `TestClock`, an `operation` that advances the clock to simulate work
yields exact latencies and throughput (the tests assert `p50 === 10ms`,
`throughput === 100/s`). Under `systemClock`, the identical harness measures
real wall-clock latency against a live target. Concurrency is verified
independently with a promise gate (exactly `concurrency` operations in flight),
so the bound is tested without depending on timing.

## 6. Non-goals

- **No load generator daemon or ramp profiles.** A single `runLoad` call is one
  scenario; ramping, sustained duration, or distributed generation compose on
  top by calling it in a loop with changing parameters.
- **No target harness bundled.** The `operation` is supplied by the caller (wire
  it to the REST app or the worker), keeping this package a pure driver.
- **No assertions/SLOs.** The report is data; deciding pass/fail against an SLO
  is the caller's (or CI's, #37) job.

## 7. Testing

14 tests: nearest-rank `percentile` (including p0, p100, and empty) and
`summarize` (values, empty, no-mutation); and `runLoad`'s deterministic latency/
throughput/wall under a `TestClock`, failure counting with latency retained, the
no-time-passed throughput fallback, the concurrency bound (via a gate) and the
cap-at-count and zero-count cases, histogram observation, and `formatReport`.
100% branch coverage.
