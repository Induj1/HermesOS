import { describe, expect, it } from 'vitest';
import { formatBriefing, formatCiAlert, isCiFailing } from '../src/briefing.js';

describe('formatBriefing', () => {
  it('renders weather and numbered headlines', () => {
    const text = formatBriefing({
      city: 'Bengaluru',
      date: 'Sat Jul 19 2026',
      weather: { tempNow: 21.4, tempMax: 28.2, tempMin: 20.2 },
      headlines: ['A big story', 'Another story'],
    });
    expect(text).toContain('Bengaluru: 21°C now, 20–28°C today');
    expect(text).toContain('1. A big story');
    expect(text).toContain('2. Another story');
    expect(text).toContain('Sat Jul 19 2026');
  });
});

describe('isCiFailing', () => {
  it('flags failing conclusions and clears passing/unknown ones', () => {
    expect(isCiFailing('failure')).toBe(true);
    expect(isCiFailing('timed_out')).toBe(true);
    expect(isCiFailing('startup_failure')).toBe(true);
    expect(isCiFailing('success')).toBe(false);
    expect(isCiFailing(null)).toBe(false);
  });
});

describe('formatCiAlert', () => {
  it('names the repo, branch, conclusion, and URL', () => {
    const text = formatCiAlert({
      repo: 'Induj1/HermesOS',
      branch: 'main',
      conclusion: 'failure',
      url: 'https://github.com/Induj1/HermesOS/actions/runs/1',
    });
    expect(text).toContain('Induj1/HermesOS (main)');
    expect(text).toContain('failure');
    expect(text).toContain('https://github.com/Induj1/HermesOS/actions/runs/1');
  });

  it('handles a null conclusion', () => {
    expect(
      formatCiAlert({ repo: 'r', branch: 'b', conclusion: null, url: 'u' }),
    ).toContain('unknown');
  });
});
