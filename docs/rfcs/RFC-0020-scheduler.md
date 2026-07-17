# RFC-0020: Background Scheduler

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Status        | Implemented                                |
| Date          | 2026-07-18                                 |
| Scope         | `packages/scheduler` (`@hermes/scheduler`) |
| Depends on    | `@hermes/kernel` (Logger)                  |
| Supersedes    | —                                          |
| Superseded by | —                                          |

Design record for the background scheduler: cron / interval / once triggers,
computed deterministically.

Covered by 31 tests in `packages/scheduler/tests`.

---

## 1. Context and boundary

The kernel's scheduler (RFC-0001) orders the tasks _within_ one mission's DAG.
This is a different job: fire _whole jobs over time_ — "every morning at 03:00",
"in five minutes", "on the first of the month". A worker runtime (#22) polls it
to decide which missions to launch.

The scheduler **runs nothing itself**. It holds jobs and answers one question:
_given it is now `nowMs`, which are due?_ What a due job does is the caller's,
so the scheduler has no dependency on the kernel runtime, a queue, or any I/O —
and is a pure function of the clock it is handed, hence fully testable with
fixed times.

## 2. Triggers

- **`once`** — an absolute time; fires once, then never.
- **`interval`** — every `everyMs`, aligned to an `anchorMs` (default epoch), so
  a "every 15 minutes" job lands on :00/:15/:30/:45 rather than drifting.
- **`cron`** — a standard 5-field expression, in **UTC**.

Each compiles once (a cron expression is parsed and validated up front, so a
malformed one throws at registration, not by silently never firing), and
`nextRun` is a pure `(compiled, afterMs) → time | undefined`.

## 3. Cron: two deliberate decisions

- **UTC, always.** Timezone-aware scheduling means DST, which means "02:30 ran
  twice / never" bugs. Computing in UTC keeps `nextAfter` a pure function of two
  numbers; a caller who wants local time converts at the edge.
- **Vixie day-of-month/day-of-week OR-semantics.** When _both_ the day-of-month
  and day-of-week fields are restricted, a time matches if it satisfies _either_
  (`0 0 1 * 1` = "the 1st **and** every Monday"). This is surprising but is the
  historical cron behaviour, so it is implemented deliberately rather than as an
  AND that would silently drop runs.

The next-time search jumps field by field (roll to the next allowed month, day,
hour, minute) rather than scanning minute by minute, and caps at four years so
an impossible expression (`0 0 30 2 *` — Feb 30) throws instead of looping.

## 4. Missed ticks coalesce

If the host slept and a job's time passed several times over, a `poll` fires it
**once** and schedules its next run after `nowMs` — not once per missed
occurrence. A scheduler is a "should this run now?" oracle, not a backlog that
replays a day of missed every-minute jobs on wake (that is a stampede). A caller
that needs every occurrence records them itself.

## 5. API

`add(job, nowMs)` (validates, computes the first run), `remove`, `has`, `size`,
`poll(nowMs)` (returns due jobs in time order — earliest first, ties by id — and
reschedules), and `nextWakeup()` (the earliest next run, so a caller sleeps
until then rather than busy-polling). The payload is generic and opaque.

## 6. Testing

Deterministic with fixed timestamps: the parser (fields, ranges, steps, lists,
`7`-as-Sunday, out-of-range rejection), `nextAfter` (minute/day/month rollover,
weekday and month restrictions, strictly-after, OR-semantics, the impossible-
expression throw), trigger next-run for all three kinds, and the scheduler
(fire/reschedule, ordering, missed-tick coalescing, one-shot removal, wakeup).
Branch coverage 96.3%.

## 7. Non-goals

- **No persistence.** Jobs live in memory; a caller that needs durability wraps
  `add`/`remove` and replays on restart (the poll model makes replay trivial —
  feed it the current time).
- **No execution / no queue.** It decides _when_, not _what_ or _how_; the
  worker runtime (#22) owns launching.
- **No seconds field / no timezones.** Minute granularity, UTC. Both are
  deliberate simplifications; a seconds field or a tz layer is additive if a
  need appears.
