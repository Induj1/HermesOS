/**
 * @hermes/health — Liveness and readiness checks with per-check timeouts.
 *
 * ```ts
 * const monitor = new HealthMonitor(
 *   [
 *     check('event-loop', () => healthy(), 'liveness'),
 *     check('database', async (signal) => {
 *       await db.ping(signal);
 *       return healthy();
 *     }),
 *   ],
 *   { clock: systemClock },
 * );
 *
 * const report = await monitor.report({ kind: 'readiness' });
 * res.status(httpStatusFor(report.status)).json(report);
 * ```
 *
 * The monitor runs every check concurrently under a deadline driven by an
 * injected `Clock`, aggregates to the worst status, and returns a per-check
 * report. Timeouts are exercised by advancing a `TestClock`, never by waiting.
 */

export {
  HealthMonitor,
  aggregate,
  check,
  degraded,
  healthy,
  httpStatusFor,
  unhealthy,
  type CheckKind,
  type CheckOutcome,
  type CheckReport,
  type HealthCheck,
  type HealthReport,
  type HealthStatus,
  type MonitorOptions,
} from './health.js';
