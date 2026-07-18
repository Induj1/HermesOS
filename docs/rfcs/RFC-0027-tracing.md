# RFC-0027: Tracing

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| Status        | Implemented                            |
| Date          | 2026-07-18                             |
| Scope         | `packages/tracing` (`@hermes/tracing`) |
| Depends on    | `@hermes/kernel` (`Clock`)             |
| Supersedes    | —                                      |
| Superseded by | —                                      |

Design record for deterministic distributed tracing: spans, W3C `traceparent`
propagation, and pluggable exporters.

Covered by 25 tests in `packages/tracing/tests`.

---

## 1. Context

Metrics (#33) tell an operator _how much_ and _how often_; tracing tells them
_where the time went_ in a single request as it crosses the planner, the model
router, a provider call, and the database. A trace is a tree of **spans**, each
a timed unit of work, linked parent-to-child and sharing one trace id.

Two decisions shape the package:

- **W3C `traceparent` is the wire format.** It is the one interoperable
  standard, so a Hermes trace stitches into any OpenTelemetry-aware backend
  (Jaeger, Tempo, Honeycomb) without a bespoke header. Propagation is two pure
  functions — `formatTraceparent` / `parseTraceparent`.
- **Everything non-deterministic is injected.** Ids come from an `IdGenerator`
  and time from a `@hermes/kernel` `Clock`, so a test asserts on exact ids
  (`0…01`) and exact durations rather than fighting randomness — the same
  determinism discipline as the scheduler and worker.

## 2. Span identity

A `SpanContext` is the propagatable identity: a 32-hex trace id, a 16-hex span
id, and the sampled flag. A **root** span (no parent) gets a fresh trace id and
the tracer's default sampled flag; a **child** inherits its parent's trace id
and sampled flag and records the parent's span id. That single rule is what
makes a whole request one connected trace.

`parseTraceparent` is strict: an unknown version, a bad length, a non-hex
character, or an all-zero id all return `undefined`, so a corrupt inbound header
**starts a fresh trace** rather than poisoning one with a bogus parent. Ids come
from `sequentialIdGenerator` (deterministic, for tests) or `randomIdGenerator`
(16/8 crypto-random bytes, in `node.ts`, for production).

## 3. Spans and their lifecycle

A `Span` is recorded through while the work runs — `setAttribute`,
`setAttributes`, `addEvent` (timestamped by the clock), `setStatus`, `setName` —
and `end()`ed once. `end()` freezes it into an immutable `FinishedSpan`
(including `durationMs`) and hands it to the exporter.

The load-bearing invariant is **`end()` is idempotent and recording after
`end()` is a no-op**. A late callback firing on an already-closed span cannot
corrupt it or double-export it — the classic tracing bug (a span ended twice, or
mutated after it was shipped). Every mutator guards on the ended flag and
returns `this` for chaining.

`SpanExporter` is the seam to a backend; `InMemorySpanExporter` is the test
double (and a fine sink for a `/debug/traces` endpoint). An OTLP HTTP exporter
is a future adapter over the shared HTTP client, not part of this core.

## 4. The ergonomic default

`Tracer.withSpan(name, fn, options?)` runs `fn` inside a span and ends it in a
`finally`, so a span **cannot be left un-ended**. A thrown error is recorded as
`error` status with its message and re-thrown; a clean return leaves the status
`unset` unless `fn` set it. This is the form almost all call sites should use;
raw `startSpan`/`end` exists for the cases where the span outlives one function.

## 5. Non-goals

- **No ambient context / async-local storage.** The parent span is passed
  explicitly (as a `SpanContext`), not pulled from a global. That keeps the core
  deterministic and dependency-free; an `AsyncLocalStorage` convenience can wrap
  it later without changing the model.
- **No sampling logic.** The sampled flag is propagated and honoured, but the
  _decision_ (head/tail sampling, rate limits) belongs to a policy layer or the
  backend, not this primitive.
- **No batching/retry export.** `InMemorySpanExporter` is synchronous; a network
  exporter with batching is an adapter, keeping this package I/O-free (only the
  `randomIdGenerator` touches `node:crypto`).

## 6. Testing

25 tests: `traceparent` format/parse round-trip and every rejection (version,
length, non-hex, all-zero, missing field) plus the sampled-bit read; sequential
id widths; span recording, `end()` export with duration, idempotent `end()`, and
the post-end no-op sweep; the exporter buffer/reset; and the tracer's root-vs-
child identity, sampled inheritance, start-time override, and `withSpan`
success/error/options paths. 98% branch coverage (100% lines/functions).
