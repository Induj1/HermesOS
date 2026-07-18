/**
 * @hermes/loadtest — A deterministic in-process load harness.
 *
 * ```ts
 * // Drive the REST app at concurrency 50 for 1000 requests:
 * const report = await runLoad({
 *   count: 1000,
 *   concurrency: 50,
 *   clock: systemClock,
 *   operation: async () => {
 *     const res = await app.handle({ method: 'GET', url: '/health', headers: {} });
 *     if (res.status >= 500) throw new Error('server error');
 *   },
 * });
 * console.log(formatReport(report));
 * ```
 *
 * With a `TestClock` whose `operation` advances it, the report is exact and
 * reproducible — the same harness measures a real target under `systemClock`.
 */

export { formatReport, runLoad, type LoadOptions, type LoadReport } from './harness.js';

export { percentile, summarize, type LatencyStats } from './stats.js';
