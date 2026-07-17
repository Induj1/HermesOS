# @hermes/scheduler

A deterministic background job scheduler — cron, interval, and one-shot
triggers.

- **Design record:** [RFC-0020](../../docs/rfcs/RFC-0020-scheduler.md).
- **Depends on:** `@hermes/kernel` (Logger).

## The idea

It holds jobs and answers one question, deterministically: _given it is now
`nowMs`, which are due?_ It runs nothing and does no I/O — a caller polls it
with the current time and does whatever a due job means. Everything is a pure
function of the clock, so schedules are fully testable with fixed timestamps.

Distinct from the kernel's task scheduler (which orders tasks within a mission);
this schedules whole jobs over time.

## Usage

```ts
import { Scheduler } from '@hermes/scheduler';

const scheduler = new Scheduler<{ mission: string }>();
scheduler.add(
  {
    id: 'nightly',
    trigger: { kind: 'cron', expression: '0 3 * * *' },
    payload: { mission: 'digest' },
  },
  now,
);
scheduler.add(
  {
    id: 'heartbeat',
    trigger: { kind: 'interval', everyMs: 60_000 },
    payload: { mission: 'ping' },
  },
  now,
);
scheduler.add(
  {
    id: 'reminder',
    trigger: { kind: 'once', atMs: fireAt },
    payload: { mission: 'remind' },
  },
  now,
);

// drive it from a timer / a worker loop:
for (const job of scheduler.poll(Date.now()))
  runtime.run(missionFor(job.payload));
const sleepUntil = scheduler.nextWakeup(); // sleep until then rather than busy-poll
```

## Triggers

- **`once`** — fire at an absolute time, then never.
- **`interval`** — every `everyMs`, aligned to `anchorMs` (default epoch).
- **`cron`** — a standard 5-field expression, **UTC**, with `*`, values, ranges,
  lists, and steps; `0` = Sunday (`7` accepted). Vixie day-of-month/day-of-week
  OR-semantics.

## Behaviour notes

- **Missed ticks coalesce** — a job that came due while the host slept fires
  once, not once per missed occurrence; its next run is after `now`.
- **One-shot jobs remove themselves** after firing.
- **`poll` returns due jobs in time order** (earliest first, ties by id).
- **No persistence / no execution** — it decides _when_; a caller owns
  durability and launching (see RFC-0020 §7).
