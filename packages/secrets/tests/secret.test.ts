/**
 * The Secret wrapper — the value escapes only through expose(); every
 * accidental-leak path renders [redacted].
 */

import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret, isSecret } from '../src/secret.js';

describe('Secret', () => {
  it('returns the raw value only through expose()', () => {
    const s = new Secret('sk-live-123');
    expect(s.expose()).toBe('sk-live-123');
  });

  it('redacts under toString and template interpolation', () => {
    const s = new Secret('sk-live-123');
    expect(s.toString()).toBe('[redacted]');
    expect(`key=${s.toString()}`).toBe('key=[redacted]');
    expect(String(s)).toBe('[redacted]');
  });

  it('redacts under JSON.stringify', () => {
    const s = new Secret('sk-live-123');
    expect(JSON.stringify({ apiKey: s })).toBe('{"apiKey":"[redacted]"}');
  });

  it('redacts under util.inspect / console.log', () => {
    const s = new Secret('sk-live-123');
    expect(inspect(s)).toBe('Secret([redacted])');
    expect(inspect({ apiKey: s })).toContain('Secret([redacted])');
  });

  it('never leaks the raw value in any rendering', () => {
    const s = new Secret('super-secret-value');
    for (const rendered of [s.toString(), JSON.stringify(s), inspect(s)]) {
      expect(rendered).not.toContain('super-secret-value');
    }
  });

  it('reports emptiness and carries a Secret tag', () => {
    expect(new Secret('').isEmpty).toBe(true);
    expect(new Secret('x').isEmpty).toBe(false);
    expect(Object.prototype.toString.call(new Secret('x'))).toBe('[object Secret]');
  });
});

describe('isSecret', () => {
  it('distinguishes a Secret from other values', () => {
    expect(isSecret(new Secret('x'))).toBe(true);
    expect(isSecret('x')).toBe(false);
    expect(isSecret(undefined)).toBe(false);
    expect(isSecret({ expose: () => 'x' })).toBe(false);
  });
});
