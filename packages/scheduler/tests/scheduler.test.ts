/**
 * The scheduler — deterministic polling, rescheduling, and missed-tick coalescing.
 */

import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.js';

const job = (
  id: string,
  everyMs: number,
  payload = id,
): Parameters<Scheduler['add']>[0] => ({
  id,
  trigger: { kind: 'interval', everyMs, anchorMs: 0 },
  payload,
});

describe('add / remove / size', () => {
  it('adds and tracks jobs', () => {
    const s = new Scheduler();
    s.add(job('a', 1000), 0).add(job('b', 2000), 0);
    expect(s.size).toBe(2);
    expect(s.has('a')).toBe(true);
    expect(s.remove('a')).toBe(true);
    expect(s.remove('a')).toBe(false);
    expect(s.size).toBe(1);
  });

  it('replaces a job when re-adding its id', () => {
    const s = new Scheduler();
    s.add(job('a', 1000), 0);
    s.add(job('a', 5000), 0);
    expect(s.size).toBe(1);
    expect(s.nextWakeup()).toBe(5000);
  });
});

describe('poll', () => {
  it('fires nothing before the first run', () => {
    const s = new Scheduler();
    s.add(job('a', 1000), 0);
    expect(s.poll(500)).toEqual([]);
  });

  it('fires a due job and reschedules it', () => {
    const s = new Scheduler();
    s.add(job('a', 1000), 0);
    expect(s.poll(1000).map((d) => d.id)).toEqual(['a']);
    expect(s.poll(1000)).toEqual([]); // already fired for this tick
    expect(s.poll(2000).map((d) => d.id)).toEqual(['a']); // next period
  });

  it('returns due jobs in time order, ties broken by id', () => {
    const s = new Scheduler();
    s.add({ id: 'b', trigger: { kind: 'once', atMs: 1000 }, payload: 'b' }, 0);
    s.add({ id: 'a', trigger: { kind: 'once', atMs: 1000 }, payload: 'a' }, 0);
    s.add({ id: 'c', trigger: { kind: 'once', atMs: 500 }, payload: 'c' }, 0);
    expect(s.poll(2000).map((d) => d.id)).toEqual(['c', 'a', 'b']);
  });

  it('coalesces missed ticks — a job fires once, not once per missed occurrence', () => {
    const s = new Scheduler();
    s.add(job('a', 1000), 0);
    // The host slept from 0 to 5500; the every-second job fires once, not five times.
    const due = s.poll(5500);
    expect(due).toHaveLength(1);
    expect(due[0]?.scheduledFor).toBe(1000);
    // Its next run is after now (6000), not backfilled.
    expect(s.nextWakeup()).toBe(6000);
  });

  it('removes a one-shot job after it fires', () => {
    const s = new Scheduler();
    s.add({ id: 'once', trigger: { kind: 'once', atMs: 1000 }, payload: 1 }, 0);
    expect(s.poll(1000).map((d) => d.id)).toEqual(['once']);
    expect(s.has('once')).toBe(false);
    expect(s.size).toBe(0);
  });

  it('carries the payload through', () => {
    const s = new Scheduler<{ mission: string }>();
    s.add(
      {
        id: 'j',
        trigger: { kind: 'interval', everyMs: 1000, anchorMs: 0 },
        payload: { mission: 'digest' },
      },
      0,
    );
    expect(s.poll(1000)[0]?.payload).toEqual({ mission: 'digest' });
  });
});

describe('nextWakeup', () => {
  it('is undefined when empty', () => {
    expect(new Scheduler().nextWakeup()).toBeUndefined();
  });

  it('is the earliest next run', () => {
    const s = new Scheduler();
    s.add(job('a', 5000), 0);
    s.add(job('b', 1000), 0);
    expect(s.nextWakeup()).toBe(1000);
  });

  it('ignores exhausted jobs', () => {
    const s = new Scheduler();
    s.add({ id: 'once', trigger: { kind: 'once', atMs: 1000 }, payload: 1 }, 0);
    s.add(job('a', 3000), 0);
    s.poll(1000); // fires and removes 'once'
    expect(s.nextWakeup()).toBe(3000);
  });
});
