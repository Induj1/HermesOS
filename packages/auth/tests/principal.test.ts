/**
 * Principals — builder defaults, the anonymous identity, and the auth check.
 */

import { describe, expect, it } from 'vitest';
import { anonymous, isAuthenticated, principal } from '../src/principal.js';

describe('principal', () => {
  it('defaults to a scopeless user', () => {
    expect(principal('u1')).toEqual({
      id: 'u1',
      kind: 'user',
      scopes: [],
      attributes: {},
    });
  });

  it('carries kind, scopes, and attributes', () => {
    expect(
      principal('svc', {
        kind: 'service',
        scopes: ['a', 'b'],
        attributes: { tenant: 't1' },
      }),
    ).toEqual({
      id: 'svc',
      kind: 'service',
      scopes: ['a', 'b'],
      attributes: { tenant: 't1' },
    });
  });
});

describe('anonymous / isAuthenticated', () => {
  it('treats anonymous as unauthenticated and others as authenticated', () => {
    expect(anonymous.kind).toBe('anonymous');
    expect(isAuthenticated(anonymous)).toBe(false);
    expect(isAuthenticated(principal('u1'))).toBe(true);
    expect(isAuthenticated(principal('svc', { kind: 'service' }))).toBe(true);
  });
});
