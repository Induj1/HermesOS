# @hermes/health

Liveness and readiness health checks — run a set of checks under per-check
timeouts and aggregate to a single worst-of status.

- **Design record:** [RFC-0026](../../docs/rfcs/RFC-0026-health.md).
- **Depends on:** `@hermes/kernel` (the `Clock`).

## Usage

```ts
import { systemClock } from '@hermes/kernel';
import { HealthMonitor, check, healthy, httpStatusFor } from '@hermes/health';

const monitor = new HealthMonitor(
  [
    check('event-loop', () => healthy(), 'liveness'),
    check('database', async (signal) => {
      await db.ping(signal);
      return healthy();
    }), // readiness by default
  ],
  { clock: systemClock, timeoutMs: 2000 },
);

// A /readyz handler:
const report = await monitor.report({ kind: 'readiness' });
res.statusCode = httpStatusFor(report.status); // 200 serving, 503 unhealthy
res.end(JSON.stringify(report));
```

## Concepts

- **Liveness vs readiness.** A check declares its `kind`; `report({ kind })`
  filters, so `/livez` (is the process alive → restart if not) and `/readyz`
  (can it serve → pull from rotation if not) run different sets.
- **Three statuses.** `healthy`, `degraded` (slow but serving — still `200`),
  `unhealthy` (`503`). A check may return one or throw (a throw → `unhealthy`).
- **Timeouts.** Each check races a deadline driven by the injected `Clock`; a
  hanging dependency becomes `unhealthy` rather than a stuck probe. Tests
  advance a `TestClock` instead of waiting.
- **Worst-of.** The report status is the worst included check, `healthy` when
  empty.
