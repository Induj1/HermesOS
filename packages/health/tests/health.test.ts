/**
 * Health checks — outcomes, aggregation, kind filtering, and deterministic
 * timeouts driven by a TestClock.
 */

import { TestClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import {
  HealthMonitor,
  aggregate,
  check,
  degraded,
  healthy,
  httpStatusFor,
  unhealthy,
  type CheckOutcome,
} from '../src/health.js';

describe('outcome helpers', () => {
  it('build the three statuses', () => {
    expect(healthy()).toEqual({ status: 'healthy' });
    expect(healthy('warm')).toEqual({ status: 'healthy', detail: 'warm' });
    expect(degraded('slow')).toEqual({ status: 'degraded', detail: 'slow' });
    expect(unhealthy('down')).toEqual({ status: 'unhealthy', detail: 'down' });
  });
});

describe('aggregate', () => {
  it('is healthy when empty', () => {
    expect(aggregate([])).toBe('healthy');
  });

  it('takes the worst status', () => {
    expect(aggregate(['healthy', 'healthy'])).toBe('healthy');
    expect(aggregate(['healthy', 'degraded'])).toBe('degraded');
    expect(aggregate(['degraded', 'unhealthy', 'healthy'])).toBe('unhealthy');
  });
});

describe('httpStatusFor', () => {
  it('maps serving to 200 and unhealthy to 503', () => {
    expect(httpStatusFor('healthy')).toBe(200);
    expect(httpStatusFor('degraded')).toBe(200);
    expect(httpStatusFor('unhealthy')).toBe(503);
  });
});

describe('HealthMonitor.report', () => {
  it('runs all checks and aggregates to the worst', async () => {
    const clock = new TestClock(1000);
    const monitor = new HealthMonitor(
      [check('a', () => healthy(), 'liveness'), check('b', () => degraded('slow'))],
      { clock },
    );
    const report = await monitor.report();
    expect(report.status).toBe('degraded');
    expect(report.timestampMs).toBe(1000);
    expect(report.checks.map((c) => c.name).sort()).toEqual(['a', 'b']);
    expect(clock.pendingTimers).toBe(0); // deadline sleeps were cancelled
  });

  it('filters by kind for /livez vs /readyz', async () => {
    const clock = new TestClock();
    const monitor = new HealthMonitor(
      [
        check('event-loop', () => healthy(), 'liveness'),
        check('database', () => unhealthy('unreachable'), 'readiness'),
      ],
      { clock },
    );
    const live = await monitor.report({ kind: 'liveness' });
    expect(live.status).toBe('healthy');
    expect(live.checks).toHaveLength(1);

    const ready = await monitor.report({ kind: 'readiness' });
    expect(ready.status).toBe('unhealthy');
  });

  it('turns a thrown error into an unhealthy outcome', async () => {
    const clock = new TestClock();
    const monitor = new HealthMonitor(
      [
        check('sync-throw', () => {
          throw new Error('boom');
        }),
        check('async-throw', async () => {
          await Promise.resolve();
          // Deliberately a non-Error, to exercise the String(error) branch.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'string failure';
        }),
      ],
      { clock },
    );
    const report = await monitor.report();
    expect(report.status).toBe('unhealthy');
    const sync = report.checks.find((c) => c.name === 'sync-throw');
    expect(sync?.detail).toBe('boom');
    const asyncCheck = report.checks.find((c) => c.name === 'async-throw');
    expect(asyncCheck?.detail).toBe('string failure');
  });

  it('times out a hanging check by advancing the clock', async () => {
    const clock = new TestClock();
    const hanging = check('stuck', () => new Promise<CheckOutcome>(() => undefined));
    const monitor = new HealthMonitor([hanging], { clock, timeoutMs: 1000 });

    const pending = monitor.report();
    await clock.advance(1000);
    const report = await pending;

    expect(report.status).toBe('unhealthy');
    expect(report.checks[0]?.detail).toMatch(/timed out after 1000ms/);
    expect(report.checks[0]?.durationMs).toBe(1000);
  });

  it('records duration from the clock', async () => {
    const clock = new TestClock(500);
    const monitor = new HealthMonitor([check('fast', () => healthy())], { clock });
    const report = await monitor.report();
    expect(report.checks[0]?.durationMs).toBe(0);
  });
});

describe('cancellation', () => {
  it('aborts checks when an already-aborted signal is passed', async () => {
    const clock = new TestClock();
    const monitor = new HealthMonitor(
      [check('watch', (signal) => (signal.aborted ? unhealthy('aborted') : healthy()))],
      { clock },
    );
    const controller = new AbortController();
    controller.abort();
    const report = await monitor.report({ signal: controller.signal });
    expect(report.checks[0]?.detail).toBe('aborted');
  });

  it('relays a later abort to a running check', async () => {
    const clock = new TestClock();
    // A check that only settles when its signal aborts — so the parent abort
    // must be relayed for the report to complete.
    const hanging = check(
      'stuck',
      (signal) =>
        new Promise<CheckOutcome>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const monitor = new HealthMonitor([hanging], { clock, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = monitor.report({ signal: controller.signal });
    controller.abort();
    const report = await pending;
    expect(report.status).toBe('unhealthy');
    expect(report.checks[0]?.detail).toBe('cancelled');
  });

  it('completes normally with a fresh, un-aborted signal', async () => {
    const clock = new TestClock();
    const monitor = new HealthMonitor([check('ok', () => healthy())], { clock });
    // Exercises the addEventListener/removeEventListener path without aborting.
    const report = await monitor.report({ signal: new AbortController().signal });
    expect(report.status).toBe('healthy');
  });
});

describe('registration', () => {
  it('add() grows the check set and size reflects it', async () => {
    const clock = new TestClock();
    const monitor = new HealthMonitor([], { clock });
    expect(monitor.size).toBe(0);
    monitor.add(check('late', () => healthy()));
    expect(monitor.size).toBe(1);
    const report = await monitor.report();
    expect(report.status).toBe('healthy');
    expect(report.checks).toHaveLength(1);
  });
});
