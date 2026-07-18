/**
 * The load harness — deterministic latency/throughput, concurrency bound,
 * failure counting, and metrics integration.
 */

import { systemClock, TestClock } from '@hermes/kernel';
import { MetricsRegistry } from '@hermes/metrics';
import { describe, expect, it } from 'vitest';
import { formatReport, runLoad } from '../src/harness.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('runLoad — deterministic timing', () => {
  it('measures latency and throughput against a TestClock', async () => {
    const clock = new TestClock();
    // Each op "takes" 10ms of logical time; concurrency 1 makes it sequential.
    const report = await runLoad({
      count: 3,
      concurrency: 1,
      clock,
      operation: () => clock.advance(10),
    });
    expect(report.count).toBe(3);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.wallMs).toBe(30);
    expect(report.latency.p50).toBe(10);
    expect(report.throughputPerSec).toBeCloseTo(100, 5); // 3 ops / 0.03s
  });

  it('counts failures but still records their latency', async () => {
    const clock = new TestClock();
    const report = await runLoad({
      count: 4,
      concurrency: 1,
      clock,
      operation: async (i) => {
        await clock.advance(5);
        if (i % 2 === 0) throw new Error('boom');
      },
    });
    expect(report.succeeded).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.latency.count).toBe(4);
  });

  it('reports throughput as count when no time passes', async () => {
    const report = await runLoad({
      count: 5,
      concurrency: 1,
      clock: new TestClock(),
      operation: () => Promise.resolve(),
    });
    expect(report.wallMs).toBe(0);
    expect(report.throughputPerSec).toBe(5);
  });
});

describe('runLoad — concurrency', () => {
  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred();
    const run = runLoad({
      count: 10,
      concurrency: 3,
      clock: systemClock,
      operation: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate.promise;
        inFlight -= 1;
      },
    });
    // Let the pool fill up, then release everything.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(inFlight).toBe(3);
    gate.resolve();
    await run;
    expect(maxInFlight).toBe(3);
  });

  it('caps workers at count when concurrency exceeds it', async () => {
    const report = await runLoad({
      count: 2,
      concurrency: 100,
      clock: new TestClock(),
      operation: () => Promise.resolve(),
    });
    expect(report.count).toBe(2);
    expect(report.succeeded).toBe(2);
  });

  it('handles a zero-count run', async () => {
    const report = await runLoad({
      count: 0,
      concurrency: 4,
      clock: new TestClock(),
      operation: () => Promise.resolve(),
    });
    expect(report.count).toBe(0);
    expect(report.latency.count).toBe(0);
  });
});

describe('runLoad — metrics', () => {
  it('observes each latency into a provided histogram', async () => {
    const clock = new TestClock();
    const registry = new MetricsRegistry();
    const histogram = registry.histogram('latency', [5, 20]);
    await runLoad({
      count: 2,
      concurrency: 1,
      clock,
      operation: () => clock.advance(10),
      histogram,
    });
    const snapshot = histogram.histograms()[0];
    expect(snapshot?.count).toBe(2);
    expect(snapshot?.sum).toBe(20);
  });
});

describe('formatReport', () => {
  it('renders a readable block', async () => {
    const clock = new TestClock();
    const report = await runLoad({
      count: 1,
      concurrency: 1,
      clock,
      operation: () => clock.advance(12),
    });
    const text = formatReport(report);
    expect(text).toContain('requests:   1 (1 ok, 0 failed)');
    expect(text).toContain('throughput:');
    expect(text).toContain('p99');
  });
});
