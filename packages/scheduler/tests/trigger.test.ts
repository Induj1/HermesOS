/**
 * Trigger compilation and next-run computation.
 */

import { describe, expect, it } from 'vitest';
import { compileTrigger, nextRun } from '../src/trigger.js';

describe('compileTrigger', () => {
  it('rejects a non-positive interval', () => {
    expect(() => compileTrigger({ kind: 'interval', everyMs: 0 })).toThrow(
      /must be > 0/,
    );
  });

  it('validates a cron expression up front', () => {
    expect(() => compileTrigger({ kind: 'cron', expression: 'bad' })).toThrow();
  });

  it('defaults an interval anchor to 0', () => {
    const compiled = compileTrigger({ kind: 'interval', everyMs: 1000 });
    expect(compiled).toEqual({ kind: 'interval', everyMs: 1000, anchorMs: 0 });
  });
});

describe('nextRun', () => {
  it('once fires at its time, then never again', () => {
    const t = compileTrigger({ kind: 'once', atMs: 5000 });
    expect(nextRun(t, 0)).toBe(5000);
    expect(nextRun(t, 5000)).toBeUndefined(); // strictly after
    expect(nextRun(t, 9000)).toBeUndefined();
  });

  it('interval fires on the next aligned boundary', () => {
    const t = compileTrigger({ kind: 'interval', everyMs: 1000, anchorMs: 0 });
    expect(nextRun(t, 0)).toBe(1000);
    expect(nextRun(t, 999)).toBe(1000);
    expect(nextRun(t, 1000)).toBe(2000);
    expect(nextRun(t, 2500)).toBe(3000);
  });

  it('interval respects a non-zero anchor', () => {
    const t = compileTrigger({ kind: 'interval', everyMs: 1000, anchorMs: 250 });
    expect(nextRun(t, 0)).toBe(250);
    expect(nextRun(t, 250)).toBe(1250);
  });

  it('cron delegates to the cron engine', () => {
    const t = compileTrigger({ kind: 'cron', expression: '0 0 * * *' });
    const at = nextRun(t, Date.parse('2026-01-01T05:00:00Z')) ?? 0;
    expect(new Date(at).toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});
