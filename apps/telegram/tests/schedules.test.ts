import { describe, expect, it } from 'vitest';
import { formatSchedule, localCronToUtc, parseSchedule } from '../src/schedules.js';

describe('parseSchedule', () => {
  it('parses friendly recurrences into local-time cron + task', () => {
    expect(parseSchedule('weekdays 9am summarise my issues')).toEqual({
      cron: '0 9 * * 1-5',
      task: 'summarise my issues',
    });
    expect(parseSchedule('daily at 8:30am morning digest')).toEqual({
      cron: '30 8 * * *',
      task: 'morning digest',
    });
    expect(parseSchedule('weekends 10pm weekend recap')).toEqual({
      cron: '0 22 * * 0,6',
      task: 'weekend recap',
    });
    expect(parseSchedule('hourly check the build')).toEqual({
      cron: '0 * * * *',
      task: 'check the build',
    });
  });

  it('accepts a raw 5-field cron followed by the task', () => {
    expect(parseSchedule('15 6 * * 1 weekly standup')).toEqual({
      cron: '15 6 * * 1',
      task: 'weekly standup',
    });
  });

  it('handles 12am/12pm and pm conversion', () => {
    expect(parseSchedule('daily 12am midnight run')?.cron).toBe('0 0 * * *');
    expect(parseSchedule('daily 12pm noon run')?.cron).toBe('0 12 * * *');
    expect(parseSchedule('daily 3pm tea')?.cron).toBe('0 15 * * *');
  });

  it('rejects malformed input', () => {
    expect(parseSchedule('')).toBeUndefined();
    expect(parseSchedule('   ')).toBeUndefined();
    expect(parseSchedule('daily at 99pm nonsense')).toBeUndefined(); // hour > 23
    expect(parseSchedule('daily at 9:99 x')).toBeUndefined(); // minute > 59
    expect(parseSchedule('daily at abc thing')).toBeUndefined(); // not a time
    expect(parseSchedule('sometime do a thing')).toBeUndefined();
  });
});

describe('localCronToUtc', () => {
  it('shifts hour/minute by the offset (IST = -330)', () => {
    // 09:00 IST → 03:30 UTC, weekday field unchanged (no day cross).
    expect(localCronToUtc('0 9 * * 1-5', -330)).toBe('30 3 * * 1-5');
  });

  it('wraps past midnight and shifts the day-of-week field back a day', () => {
    // 02:00 IST → 20:30 UTC previous day; Mon–Fri → Sun–Thu.
    expect(localCronToUtc('0 2 * * 1-5', -330)).toBe('30 20 * * 0-4');
  });

  it('wraps forward across midnight for a behind-UTC zone', () => {
    // 23:00 local at UTC-2 → 01:00 UTC next day; Sat,Sun → Sun,Mon.
    expect(localCronToUtc('0 23 * * 0,6', 120)).toBe('0 1 * * 1,0');
  });

  it('leaves non-integer fields and non-5-field strings alone', () => {
    expect(localCronToUtc('0 * * * *', -330)).toBe('0 * * * *');
    expect(localCronToUtc('*/5 9 * * *', -330)).toBe('*/5 9 * * *'); // minute not int
    expect(localCronToUtc('30 */2 * * *', -330)).toBe('30 */2 * * *'); // hour not int
    expect(localCronToUtc('not a cron', -330)).toBe('not a cron'); // not 5 fields
  });
});

describe('formatSchedule', () => {
  it('renders a one-line summary', () => {
    expect(
      formatSchedule({
        id: 'job_1',
        chatId: 42,
        cron: '0 9 * * 1-5',
        prompt: 'digest',
      }),
    ).toBe('• job_1 — [0 9 * * 1-5] digest');
  });
});
