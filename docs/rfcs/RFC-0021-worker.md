# RFC-0021: Worker Runtime

| Field         | Value                                                 |
| ------------- | ----------------------------------------------------- |
| Status        | Implemented                                           |
| Date          | 2026-07-18                                            |
| Scope         | `packages/worker` (`@hermes/worker`)                  |
| Depends on    | `@hermes/kernel` (Clock, Logger), `@hermes/scheduler` |
| Supersedes    | —                                                     |
| Superseded by | —                                                     |

Design record for the worker runtime: a job queue and a deterministic processing
loop with retries and a dead-letter queue.

Covered by 20 tests in `packages/worker/tests`.

---

## 1. Context

The scheduler (RFC-0020) decides _when_ a job is due; the kernel runs a
mission's tasks. The worker is the loop between them: it drains a queue of jobs,
runs each through a handler, and settles the outcome (ack / retry /
dead-letter). Given a scheduler, it enqueues due jobs each tick, so "every
morning, run the digest" becomes a queued job processed like any other.

## 2. The queue is a port

The worker drains work through a small {@link JobQueue} interface — `enqueue`,
`claim`, `ack`, `retry`, `deadLetter` — so the _store_ is swappable: the {@link
InMemoryJobQueue} is the default and the test double; a Postgres- or
Redis-backed queue implements the same verbs and the worker never changes.
Everything time-related is an absolute `availableAtMs`, so the store needs no
clock and a caller drives time. The in-memory queue uses a **monotonic id
counter** (not random) and returns claims in availability order, so a test
predicts ids and the drain order is defined rather than a `Map`-iteration
accident.

## 3. `tick` is the core

The whole worker is {@link Worker.tick}, one step over an explicit `nowMs`:
enqueue what the scheduler has due, claim up to `concurrency`, run each handler,
and settle. Building around a `tick(nowMs)` is what makes retries, backoff,
concurrency, and dead-lettering testable with no real time and no real scheduler
tick — the same discipline the scheduler and embedding service use.

- **Success** → `ack` (removed).
- **Failure with attempts left** → `retry`, available at
  `nowMs + backoffMs · 2^(attempt-1)` (exponential backoff).
- **Failure at the last attempt** → `deadLetter` with the error message, kept
  for inspection rather than lost.

`runForever` is a thin timer loop over `tick`, using the kernel's `Clock` for
time and a cancellable `sleep` — deliberately not where the logic lives.

## 4. Reusing the kernel Clock (a de-duplication)

An earlier draft carried its own cancellable-sleep, a copy of one already in the
embedding service, the GitHub client, and the HTTP client. The kernel already
exports exactly the right abstraction — a `Clock` with `now()` and a
`CancellationError`-rejecting `sleep(ms, signal)`, plus a `TestClock` for
determinism — so the worker takes a `Clock` instead. One fewer copy of the
timer, and `runForever` is testable by injecting a `TestClock` or a trivial
fake. (The remaining copies in embedding/github are a follow-up consolidation,
tracked in STATUS.md.)

## 5. Testing

Deterministic, `tick` driven with fixed times: the queue
(enqueue/claim/ack/retry/ deadLetter, availability, max, id monotonicity,
ignore-unknown), and the worker (process+ack, concurrency bound,
retry-with-backoff → dead-letter, retry-then- recover, non-Error rejection,
attempt/signal passed to the handler, scheduler feed, and `runForever` abort
paths). Branch coverage 97.9%.

## 6. Non-goals

- **No mission logic.** The handler is the caller's — it might call
  `runtime.run(...)`; the worker only decides claim/retry/dead-letter.
- **No durable queue implementation.** The in-memory queue is complete and is
  the reference; a durable store is a straightforward `JobQueue` implementation.
- **No cross-process coordination.** One worker over one queue; scaling to many
  workers over a shared durable queue is the durable store's concern (a claim
  must be atomic there), not the loop's.
