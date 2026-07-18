# RFC-0028: Observability (Structured Logging)

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| Status        | Implemented                                       |
| Date          | 2026-07-18                                        |
| Scope         | `packages/logger` (`@hermes/logger`)              |
| Depends on    | `@hermes/kernel` (`Logger`, `LogFields`, `Clock`) |
| Supersedes    | —                                                 |
| Superseded by | —                                                 |

Design record for Observability (#32), realized as the structured logging
subsystem that carries context and correlates with the other signals.

Covered by 18 tests in `packages/logger/tests`.

---

## 1. Context and scope

Observability is three signals: **metrics** (#33, how much/how often),
**tracing** (#34, where the time went), and **logs** (what happened, with
context). Metrics, tracing, and health (#35) already ship. This milestone fills
the third — **structured logging** — and the correlation that turns three
separate signals into one story: a log line carrying the same `traceId` as a
span lines up in a backend without manual stitching.

The kernel already declares a minimal `Logger` interface (`debug`/`info`/`warn`/
`error` + `child`) and a `noopLogger`, so the whole system already logs against
an abstraction. This package provides the concrete structured implementation the
host injects. There is no separate "observability facade" object: composing the
signals is the service's job (give a subsystem a `Logger`, a `MetricsRegistry`,
a `Tracer`), and inventing a bundle that owns all three would just couple them.

## 2. Structured records

`StructuredLogger` emits a `LogRecord` per call — level, message, a timestamp
from an injected `Clock`, and a merged field bag — to an injected `LogSink`.
Because time and output are injected, the logger is **deterministic and does no
I/O itself**: a test asserts on the exact records, and the console is one
adapter among several. Three properties earn their keep:

- **Levels filter before the sink.** A record below the configured level is
  dropped by a single rank comparison, so `debug` calls left in the code cost
  almost nothing in production at `level: 'info'`.
- **`child` binds context.** `logger.child({ requestId })` returns a logger that
  stamps that field onto every downstream record — how one request's logs are
  correlated. Child fields merge over parent fields (child wins), and per-call
  fields merge over both.
- **Secrets stay redacted.** A `@hermes/secrets` `Secret` in a field serializes
  as `[redacted]` through its `toJSON`, so context is safe to log with **no
  allowlist to maintain** — the leak-resistant default composes for free.

## 3. Sinks and formatting

`formatJsonLine` is the canonical rendering: one JSON object per line — the
shape every aggregator ingests — with core keys (`time`, `level`, `msg`) always
first and always the same. A field that reuses a core key is **dropped rather
than allowed to shadow it**, so every line parses identically no matter what a
caller puts in the fields. `MemorySink` is the test double (and a fine buffer
for a debug endpoint); `jsonLinesSink(write)` renders through an injected
writer; and `consoleSink` (in `node.ts`, the only module that touches a real
stream) splits `warn`/`error` to stderr and `debug`/`info` to stdout, so an
operator separates problems from chatter with a redirect.

## 4. Trace correlation

`withTrace(logger, spanContext)` returns a child logger stamped with the
`traceId`/`spanId`. It is kept **structural** — it takes `{ traceId, spanId }`,
not `@hermes/tracing`'s `SpanContext` — so the logger does not depend on the
tracing package, yet a real `SpanContext` satisfies it by shape. That is the
whole correlation mechanism: bind once at the request boundary, and every line
the request logs carries the ids the trace does.

## 5. Non-goals

- **No log sampling or rate limiting.** Levels are the only filter; a sampling
  policy can wrap a sink later.
- **No async/batched shipping.** `consoleSink` and `jsonLinesSink` are
  synchronous; a network log shipper with batching is an adapter over the same
  `LogSink` seam, keeping this core I/O-free.
- **No pretty/dev formatter.** JSON lines only. A human-readable dev formatter
  is a future sink, not a change to the record model.

## 6. Testing

18 tests: level defaulting and filtering across all four levels; clock-stamped
timestamps; bound/per-call/child field merging and precedence; `isLevelEnabled`;
`formatJsonLine` core-key ordering, reserved-key dropping, and `Secret`-like
redaction; `MemorySink` collect/render/reset; `jsonLinesSink`; `consoleSink`
stream routing (stdout vs stderr); and `traceFields`/`withTrace` correlation.
100% branch coverage.
