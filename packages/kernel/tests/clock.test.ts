import { describe, expect, it, vi } from 'vitest';

import { TestClock, systemClock } from '../src/clock.js';
import { CancellationError } from '../src/errors.js';

describe('TestClock', () => {
  it('does not move on its own', async () => {
    const clock = new TestClock(1_000);
    const settled = vi.fn();
    void clock.sleep(50).then(settled);

    await Promise.resolve();

    expect(clock.now()).toBe(1_000);
    expect(settled).not.toHaveBeenCalled();
  });

  it('fires a sleep once time reaches its deadline', async () => {
    const clock = new TestClock(0);
    const settled = vi.fn();
    void clock.sleep(100).then(settled);

    await clock.advance(99);
    expect(settled).not.toHaveBeenCalled();

    await clock.advance(1);
    expect(settled).toHaveBeenCalledOnce();
    expect(clock.now()).toBe(100);
  });

  it('fires every sleep that a single advance passes', async () => {
    const clock = new TestClock(0);
    const fired: number[] = [];
    void clock.sleep(10).then(() => void fired.push(10));
    void clock.sleep(20).then(() => void fired.push(20));
    void clock.sleep(500).then(() => void fired.push(500));

    await clock.advance(100);

    expect(fired).toEqual([10, 20]);
    expect(clock.pendingTimers).toBe(1);
  });

  it('rejects a sleep when its signal aborts, and drops the timer', async () => {
    const clock = new TestClock(0);
    const controller = new AbortController();
    const pending = clock.sleep(100, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow(CancellationError);
    expect(clock.pendingTimers).toBe(0);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const clock = new TestClock(0);

    await expect(clock.sleep(100, AbortSignal.abort())).rejects.toThrow(
      CancellationError,
    );
    expect(clock.pendingTimers).toBe(0);
  });

  it('leaves no timer behind once a sleep completes', async () => {
    const clock = new TestClock(0);
    const pending = clock.sleep(10);

    await clock.advance(10);
    await pending;

    expect(clock.pendingTimers).toBe(0);
  });
});

describe('systemClock', () => {
  it('reports real time', () => {
    expect(systemClock.now()).toBeCloseTo(Date.now(), -2);
  });

  it('actually sleeps', async () => {
    const before = systemClock.now();

    await systemClock.sleep(5);

    expect(systemClock.now() - before).toBeGreaterThanOrEqual(4);
  });

  it('rejects on abort', async () => {
    const controller = new AbortController();
    const pending = systemClock.sleep(10_000, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow(CancellationError);
  });
});
