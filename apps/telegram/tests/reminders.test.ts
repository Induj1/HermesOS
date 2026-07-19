import { describe, expect, it } from 'vitest';
import { humanDuration, parseDuration, parseReminder } from '../src/reminders.js';

describe('parseDuration', () => {
  it('parses s/m/h/d', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });
  it('rejects nonsense', () => {
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration('10x')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
  });
});

describe('parseReminder', () => {
  it('splits duration and message', () => {
    expect(parseReminder('30m call mom')).toEqual({
      ms: 1_800_000,
      message: 'call mom',
    });
  });
  it('rejects a missing message or bad duration', () => {
    expect(parseReminder('30m')).toBeUndefined();
    expect(parseReminder('later do things')).toBeUndefined();
    expect(parseReminder('30m   ')).toBeUndefined();
  });
});

describe('humanDuration', () => {
  it('renders a short human string', () => {
    expect(humanDuration(30_000)).toBe('30s');
    expect(humanDuration(1_800_000)).toBe('30 min');
    expect(humanDuration(7_200_000)).toBe('2h');
    expect(humanDuration(172_800_000)).toBe('2d');
  });
});
