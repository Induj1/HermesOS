/**
 * Latency statistics — percentiles and a summary over a sample of durations.
 *
 * Percentiles are the nearest-rank kind: `percentile(sorted, 90)` is the value
 * at rank `ceil(0.9 · n)`, so p100 is the max and p0 the min. Averages hide the
 * tail that actually hurts under load, which is why the summary leads with p50/
 * p90/p99, not the mean.
 */

export interface LatencyStats {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

const EMPTY: LatencyStats = {
  count: 0,
  min: 0,
  max: 0,
  mean: 0,
  p50: 0,
  p90: 0,
  p99: 0,
};

/** The nearest-rank percentile `p` (0–100) of an ascending-sorted sample. */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  // For an empty sample `index` is -1, so the read is `undefined` → 0.
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** Summarize a latency sample (in any order). */
export function summarize(latencies: readonly number[]): LatencyStats {
  if (latencies.length === 0) return EMPTY;
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: Math.min(...sorted),
    max: Math.max(...sorted),
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  };
}
