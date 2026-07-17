# @hermes/worker

A worker runtime — a job queue and a deterministic processing loop with retries
and a dead-letter queue.

- **Design record:** [RFC-0021](../../docs/rfcs/RFC-0021-worker.md).
- **Depends on:** `@hermes/kernel` (Clock, Logger), `@hermes/scheduler`.

## The idea

A `Worker` drains a `JobQueue`, running each job through a handler and settling
it (ack / retry-with-backoff / dead-letter), with bounded concurrency. Given a
`@hermes/scheduler`, it enqueues due scheduled jobs each tick — so a cron job
becomes a queued job processed like any other.

The core is `tick(nowMs)`, one deterministic step; `runForever` is a thin timer
loop over it. The queue is a port: the `InMemoryJobQueue` is the default and the
test double; a durable store implements the same interface.

## Usage

```ts
import { Worker } from '@hermes/worker';

const worker = new Worker<{ mission: string }>({
  handler: async (job, ctx) => {
    // ctx.attempts, ctx.signal (aborts on shutdown)
    await runtime.run(missionFor(job.mission));
  },
  concurrency: 8,
  maxAttempts: 5,
  backoffMs: 1000,
});

await worker.submit({ mission: 'digest' });
await worker.runForever({ signal: shutdown.signal });
```

With a scheduler feeding it:

```ts
const worker = new Worker<Job, Payload>({
  handler,
  scheduler,               // @hermes/scheduler
  toJob: (payload) => ...,  // scheduled payload -> queue body
});
// each tick enqueues due scheduled jobs, then drains the queue
```

## Behaviour

- **Retries with exponential backoff** — a failing job is requeued at
  `now + backoffMs · 2^(attempt-1)`, up to `maxAttempts`, then **dead-lettered**
  (kept for inspection).
- **Bounded concurrency** — at most `concurrency` jobs run per tick.
- **Deterministic** — `tick(nowMs)` is a pure step; drive it with fixed times
  (and a kernel `TestClock` for `runForever`).

## Testing

Everything runs against the in-memory queue with `tick` driven by fixed times —
no real timers, no flakiness. Inject a `TestClock` (from `@hermes/kernel`) for
`runForever`.
