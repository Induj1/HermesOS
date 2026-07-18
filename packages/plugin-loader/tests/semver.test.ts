/**
 * Minimal semver — parse, compare, and API compatibility.
 */

import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isApiCompatible,
  parseVersion,
  type Version,
} from '../src/semver.js';

/** Parse a version known-good in a test, without a non-null assertion. */
function v(text: string): Version {
  const parsed = parseVersion(text);
  if (parsed === undefined) throw new Error(`test used an invalid version: ${text}`);
  return parsed;
}

describe('parseVersion', () => {
  it('parses major.minor.patch', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('  0.0.0 ')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('rejects non-semver', () => {
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('1.2.3-beta')).toBeUndefined();
    expect(parseVersion('v1.2.3')).toBeUndefined();
    expect(parseVersion('nope')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(v('1.0.0'), v('2.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.3.0'), v('1.2.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toBe(0);
    expect(compareVersions(v('1.2.4'), v('1.2.3'))).toBeGreaterThan(0);
  });
});

describe('isApiCompatible', () => {
  it('requires the same major', () => {
    expect(isApiCompatible(v('2.0.0'), v('1.9.9'))).toBe(false);
    expect(isApiCompatible(v('1.0.0'), v('2.0.0'))).toBe(false);
  });

  it('requires the host to be at least the plugin version', () => {
    expect(isApiCompatible(v('1.5.0'), v('1.2.0'))).toBe(true); // host newer
    expect(isApiCompatible(v('1.2.0'), v('1.2.0'))).toBe(true); // equal
    expect(isApiCompatible(v('1.2.0'), v('1.3.0'))).toBe(false); // plugin newer
  });
});
