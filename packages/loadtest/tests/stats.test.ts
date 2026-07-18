/**
 * Latency statistics — percentiles and the summary.
 */

import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../src/stats.js';

describe('percentile', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses nearest-rank', () => {
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 100)).toBe(10);
  });

  it('clamps p0 to the minimum', () => {
    expect(percentile(sorted, 0)).toBe(1);
  });

  it('returns 0 for an empty sample', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summarize', () => {
  it('computes count, min, max, mean, and percentiles', () => {
    const stats = summarize([10, 30, 20, 50, 40]);
    expect(stats).toEqual({
      count: 5,
      min: 10,
      max: 50,
      mean: 30,
      p50: 30,
      p90: 50,
      p99: 50,
    });
  });

  it('is zeroed for an empty sample', () => {
    expect(summarize([])).toEqual({
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p99: 0,
    });
  });

  it('does not mutate the input', () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
