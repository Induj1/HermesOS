/**
 * The load harness — drive an operation at a bounded concurrency and measure.
 *
 * `runLoad` runs `operation` `count` times through a pool of at most
 * `concurrency` workers, timing each call with an injected `Clock` and
 * aggregating a `LoadReport` (throughput and latency percentiles). It drives the
 * REST `Application` or the `Worker` through *their* ports — pass an `operation`
 * that issues a request or enqueues+drains a job — so the harness itself stays a
 * pure function of `(count, concurrency, clock, operation)`.
 *
 * Determinism: with a `TestClock` whose `operation` advances it to simulate
 * work, latencies and throughput are exact and reproducible; with `systemClock`
 * the same code measures real wall-clock latency against a live target.
 */

import type { Clock } from '@hermes/kernel';
import type { Histogram } from '@hermes/metrics';
import { summarize, type LatencyStats } from './stats.js';

export interface LoadOptions {
  /** How many operations to run in total. */
  readonly count: number;
  /** The most operations in flight at once. */
  readonly concurrency: number;
  readonly clock: Clock;
  /** The unit of work; may throw to record a failure. */
  readonly operation: (index: number) => Promise<void>;
  /** Optional metrics histogram to observe each latency into. */
  readonly histogram?: Histogram;
}

export interface LoadReport {
  readonly count: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Wall time across the whole run, by the clock. */
  readonly wallMs: number;
  /** Completed operations per second (`count / wallSeconds`). */
  readonly throughputPerSec: number;
  readonly latency: LatencyStats;
}

export async function runLoad(options: LoadOptions): Promise<LoadReport> {
  const { count, concurrency, clock, operation, histogram } = options;
  const latencies: number[] = [];
  let next = 0;
  let succeeded = 0;
  let failed = 0;

  const start = clock.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      const opStart = clock.now();
      try {
        await operation(index);
        succeeded += 1;
      } catch {
        // A failed operation still counts toward latency — a timeout or error
        // has a duration, and hiding it would flatter the report.
        failed += 1;
      }
      const latency = clock.now() - opStart;
      latencies.push(latency);
      histogram?.observe(latency);
    }
  };

  const workers = Math.max(1, Math.min(concurrency, count));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const wallMs = clock.now() - start;
  return {
    count,
    succeeded,
    failed,
    wallMs,
    throughputPerSec: wallMs > 0 ? (count / wallMs) * 1000 : count,
    latency: summarize(latencies),
  };
}

/** Render a report as a compact, human-readable block. */
export function formatReport(report: LoadReport): string {
  const l = report.latency;
  return [
    `requests:   ${String(report.count)} (${String(report.succeeded)} ok, ${String(report.failed)} failed)`,
    `wall:       ${report.wallMs.toFixed(1)}ms`,
    `throughput: ${report.throughputPerSec.toFixed(1)}/s`,
    `latency:    min ${l.min.toFixed(1)} · p50 ${l.p50.toFixed(1)} · p90 ${l.p90.toFixed(1)} · p99 ${l.p99.toFixed(1)} · max ${l.max.toFixed(1)} (ms)`,
  ].join('\n');
}
