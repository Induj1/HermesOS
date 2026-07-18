# Performance (#40)

Milestone #40 is **measured, behaviour-preserving optimization** — find hot
paths with the load harness (#39) and the metrics (#33), change them, and record
the before/after. This document is the standing record of that work and the
method behind it.

An honesty note up front: real percentile numbers require a real run environment
(a built image or a running process, a load generator, wall-clock time). The
sandbox this milestone was authored in has none of those, so this document
delivers the **method and the instrumentation** rather than fabricated benchmark
figures — a made-up "p99 improved 40%" would be worse than no number. The
harness and metrics needed to produce the real numbers ship and are tested;
running them is the one infra-gated step.

## 1. Method

1. **Instrument.** The API service (`apps/api`) already counts requests
   (`http_requests_total`) and times them into a histogram
   (`http_request_duration_ms`) via its observability middleware. Any subsystem
   under test gets the same treatment: a `@hermes/metrics` histogram on the hot
   call.
2. **Baseline.** Drive the target with `@hermes/loadtest` `runLoad` at a fixed
   `count`/`concurrency`, feeding latencies into the histogram, and record
   `formatReport` output (throughput, p50/p90/p99/max).
3. **Change one thing.** Apply a single behaviour-preserving optimization.
4. **Re-measure** with the identical scenario and compare.
5. **Guard.** Every existing test and the ≥95% coverage threshold must still
   pass — an optimization that changes behaviour is a bug, not a win.

Because `runLoad` is deterministic under a `TestClock`, a **regression test**
for an optimization (e.g. "this path makes at most N allocations / calls") can
be written deterministically, separately from the wall-clock benchmark.

## 2. Candidate hot paths (to measure first)

These are the paths most likely to matter under load, ordered by how often they
run per request:

- **REST routing** (`@hermes/rest` `Router.match`) — runs on every request.
  Currently a first-match linear scan over compiled segment patterns. Fine for
  small route tables; if a large table shows up in the p99, a method→trie index
  is the change.
- **Context packing** (`@hermes/context`) — token-budget assembly per model
  call. String length work dominates; a cheaper token estimate or incremental
  packing is the lever.
- **Model router selection** (`@hermes/model-router`) — capability filtering per
  call; small today, watch it as provider count grows.
- **Queue claim** (`@hermes/worker` `InMemoryJobQueue.claim`) — an
  availability-ordered scan per tick; a heap keyed on `availableAtMs` is the
  change if the queue gets deep.
- **Provider request shaping** (`@hermes/provider-*`) — JSON serialization per
  call; almost certainly dominated by network, so measure before touching.

## 3. Design properties that already help

Performance was not deferred wholesale to this milestone; several structural
choices keep the common path cheap:

- **Levels filter before the sink** (`@hermes/logger`) — a `debug` call at
  `level: info` costs one integer comparison, so instrumentation left in place
  is nearly free.
- **Metrics are plain accumulators** (`@hermes/metrics`) — no clock, no I/O on
  the hot path; the cost is a map lookup and an add.
- **Zero-dependency cores** — no framework overhead on routing, config, auth, or
  authz; each is a small pure function.
- **Bounded concurrency everywhere** — the worker, the embedding platform, and
  the load harness all cap in-flight work, so a spike degrades latency rather
  than exhausting memory.

## 4. What remains (infra-gated)

To turn this method into recorded numbers:

1. Build the image (#36) or run `apps/api` locally.
2. Run `runLoad` against `/` and `/livez` at a few concurrency levels; capture
   `formatReport`.
3. Profile the top path from step 2 (`node --prof` or a flamegraph), apply one
   change, re-measure, and append a **before/after row** to this document.

No optimization is recorded here yet precisely because none has been _measured_
here. The instrumentation to measure is in place and tested.
