/**
 * Scope matching — exact, wildcard, and multi-scope coverage.
 */

import { describe, expect, it } from 'vitest';
import { hasAllScopes, hasScope, scopeMatches } from '../src/scope.js';

describe('scopeMatches', () => {
  it('matches exactly', () => {
    expect(scopeMatches('missions:read', 'missions:read')).toBe(true);
    expect(scopeMatches('missions:read', 'missions:write')).toBe(false);
  });

  it('matches a trailing wildcard over remaining segments', () => {
    expect(scopeMatches('missions:*', 'missions:read')).toBe(true);
    expect(scopeMatches('missions:*', 'missions:read:own')).toBe(true);
    expect(scopeMatches('missions:*', 'agents:read')).toBe(false);
  });

  it('treats a bare * as granting everything', () => {
    expect(scopeMatches('*', 'anything:at:all')).toBe(true);
  });

  it('does not match when the wildcard prefix is longer than the requirement', () => {
    expect(scopeMatches('a:b:*', 'a')).toBe(false);
  });

  it('only honours a wildcard in the trailing segment', () => {
    // A '*' that is not the last segment is a literal, so it cannot match.
    expect(scopeMatches('*:read', 'missions:read')).toBe(false);
  });
});

describe('hasScope / hasAllScopes', () => {
  it('reports whether any granted scope covers the requirement', () => {
    expect(hasScope(['agents:read', 'missions:*'], 'missions:write')).toBe(true);
    expect(hasScope(['agents:read'], 'missions:write')).toBe(false);
  });

  it('requires every scope for hasAllScopes', () => {
    expect(hasAllScopes(['missions:*'], ['missions:read', 'missions:write'])).toBe(
      true,
    );
    expect(hasAllScopes(['missions:read'], ['missions:read', 'missions:write'])).toBe(
      false,
    );
    expect(hasAllScopes([], [])).toBe(true);
  });
});
