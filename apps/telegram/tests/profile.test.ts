import { describe, expect, it } from 'vitest';
import { withOwnerProfile } from '../src/profile.js';

describe('withOwnerProfile', () => {
  const base = 'You are Hermes.';

  it('returns the base prompt unchanged when no profile is set', () => {
    expect(withOwnerProfile(base)).toBe(base);
    expect(withOwnerProfile(base, '')).toBe(base);
    expect(withOwnerProfile(base, '   ')).toBe(base);
  });

  it('appends the owner block when a profile is given', () => {
    const out = withOwnerProfile(base, 'Induj Gupta — full-stack + security engineer.');
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain('ABOUT YOUR USER');
    expect(out).toContain('Induj Gupta');
    expect(out).toContain('by name');
  });
});
