/**
 * The cron parser and next-time computation, in UTC with fixed timestamps.
 */

import { describe, expect, it } from 'vitest';
import { parseCron, nextAfter } from '../src/cron.js';

/** Compute the next run and return it as an ISO string for readable assertions. */
const next = (expr: string, fromIso: string): string =>
  new Date(nextAfter(parseCron(expr), Date.parse(fromIso))).toISOString();

describe('parseCron', () => {
  it('rejects an expression without five fields', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('* * * * * *')).toThrow(/5 fields/);
  });

  it('parses star, values, ranges, lists, and steps', () => {
    const cron = parseCron('0,30 9-17 * * 1-5');
    expect([...cron.minutes]).toEqual([0, 30]);
    expect([...cron.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(cron.domRestricted).toBe(false);
    expect(cron.dowRestricted).toBe(true);
  });

  it('parses a step over a star and over a range', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('10-20/5 * * * *').minutes]).toEqual([10, 15, 20]);
  });

  it('treats 7 as Sunday (0)', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('rejects out-of-range and malformed fields', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('* 25 * * *')).toThrow(/out of range/);
    expect(() => parseCron('x * * * *')).toThrow(/invalid/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step must be/);
    expect(() => parseCron('5-1 * * * *')).toThrow(/out of range/);
  });
});

describe('nextAfter', () => {
  it('finds the next matching minute', () => {
    expect(next('*/15 * * * *', '2026-01-01T10:07:00Z')).toBe(
      '2026-01-01T10:15:00.000Z',
    );
  });

  it('rolls to the next day for a daily time', () => {
    expect(next('0 3 * * *', '2026-01-01T05:00:00Z')).toBe('2026-01-02T03:00:00.000Z');
    expect(next('0 3 * * *', '2026-01-01T01:00:00Z')).toBe('2026-01-01T03:00:00.000Z');
  });

  it('is strictly after the given time (does not return the same minute)', () => {
    expect(next('0 3 * * *', '2026-01-01T03:00:00Z')).toBe('2026-01-02T03:00:00.000Z');
  });

  it('matches a weekday restriction', () => {
    // 2026-01-01 is a Thursday; next Monday 09:00 is 2026-01-05.
    expect(next('0 9 * * 1', '2026-01-01T00:00:00Z')).toBe('2026-01-05T09:00:00.000Z');
  });

  it('rolls across a month boundary', () => {
    expect(next('0 0 1 * *', '2026-01-15T00:00:00Z')).toBe('2026-02-01T00:00:00.000Z');
  });

  it('honours a month restriction', () => {
    expect(next('0 0 1 7 *', '2026-01-01T00:00:00Z')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('uses OR semantics when both day-of-month and day-of-week are restricted', () => {
    // "1st of the month OR any Monday". From Thu 2026-01-01, the next Monday
    // (2026-01-05) comes before the next 1st, so it wins.
    expect(next('0 0 1 * 1', '2026-01-01T12:00:00Z')).toBe('2026-01-05T00:00:00.000Z');
  });

  it('throws for an impossible expression', () => {
    // 30th of February never occurs.
    expect(() =>
      nextAfter(parseCron('0 0 30 2 *'), Date.parse('2026-01-01T00:00:00Z')),
    ).toThrow(/no matching time/);
  });
});
