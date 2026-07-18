# RFC-0026: Health & Diagnostics

| Field         | Value                                |
| ------------- | ------------------------------------ |
| Status        | Implemented                          |
| Date          | 2026-07-18                           |
| Scope         | `packages/health` (`@hermes/health`) |
| Depends on    | `@hermes/kernel` (`Clock`)           |
| Supersedes    | —                                    |
| Superseded by | —                                    |

Design record for liveness/readiness health checks with per-check timeouts and
worst-of aggregation.

Covered by 13 tests in `packages/health/tests`.

---

## 1. Context

An orchestrator (Docker, Kubernetes, a load balancer) asks a running service two
questions, and conflating them causes outages:

- **Liveness** — is the process itself healthy, or wedged? A failing liveness
  check gets the container **killed and restarted**.
- **Readiness** — can the service serve traffic _right now_ (database, model
  provider, queue all reachable)? A failing readiness check **pulls the instance
  out of rotation** without killing it, so a transient dependency blip does not
  trigger a restart loop.

A check that answers the wrong question is dangerous: a readiness probe wired to
liveness turns a five-second database hiccup into a crash-loop. So a check
declares its `kind`, and the monitor filters by it — `/livez` runs the liveness
checks, `/readyz` the readiness ones.

## 2. Checks

A `HealthCheck` names itself, declares its `kind`, and `run`s to a
`CheckOutcome` — one of `healthy` / `degraded` / `unhealthy`, with an optional
human detail. `degraded` is deliberately distinct from `unhealthy`: a service
that is slow but serving is degraded (still `200`, still in rotation), whereas
unhealthy means "do not send me traffic".

`check(name, fn, kind?)` builds one from a function; the function may return an
outcome or **throw**, and a throw becomes `unhealthy` with the error's message,
so a check body can `assert`/`throw` naturally. A non-`Error` throw is
stringified rather than lost.

## 3. The monitor

`HealthMonitor` runs a set of checks **concurrently**, each under a
**deadline**, and aggregates. Two design points:

- **Timeouts are the point.** A health check whose dependency hangs is the
  common failure, so each check races against a deadline; exceeding it is an
  `unhealthy` outcome, not a hung probe. The deadline is driven by an injected
  `@hermes/kernel` `Clock` and a per-check `AbortController`, so the losing side
  of the race (the pending sleep, or the check itself) is always cancelled — no
  leaked timers (asserted via `TestClock.pendingTimers`) — and a timeout is
  exercised by advancing a `TestClock`, never by really waiting.
- **Worst-of aggregation.** The report's status is the worst among the included
  checks (`unhealthy` < `degraded` < `healthy`), and `healthy` when there are
  none — the correct default for "nothing is wrong".

`report({ kind })` returns a `HealthReport`: the aggregate status, a per-check
line (name, kind, outcome, `durationMs`), and a `timestampMs` from the clock.

## 4. The HTTP boundary

`httpStatusFor(status)` maps a status to a code — `200` while serving (healthy
or degraded), `503` when unhealthy. It lives here, not in `@hermes/rest`, so it
is a pure function a `/readyz` route composes with no REST dependency (the same
direction as the rest of the system: shared layers stay ignorant of their
consumers). A route handler is three lines: run the monitor, map the status,
serialize the report.

## 5. Non-goals

- **No metrics or tracing.** Those are #33/#34; the aggregate Observability view
  (#32) composes health, metrics, and tracing rather than this package reaching
  into them.
- **No built-in checks.** A database ping or a provider reachability check is
  the owning subsystem's to supply — this package is the harness, not a catalog,
  so it stays dependency-light (only the kernel `Clock`).
- **No background polling.** A report is produced on demand, when the probe
  endpoint is hit. Caching or scheduled evaluation can layer on top without
  changing this core.

## 6. Testing

13 tests: the outcome helpers and the HTTP mapping; worst-of aggregation
(including the empty case); `kind` filtering for `/livez` vs `/readyz`; a thrown
`Error` and a thrown non-`Error` both becoming `unhealthy`; a hanging check
timing out when a `TestClock` is advanced (with duration and no leaked timers);
a mid-flight parent abort relayed to a running check; and `add`/`size`. 100%
branch coverage.
