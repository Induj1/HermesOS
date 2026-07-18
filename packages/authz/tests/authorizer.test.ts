/**
 * Authorization — direct scope checks and the deny-override policy engine.
 */

import { anonymous, principal } from '@hermes/auth';
import { describe, expect, it } from 'vitest';
import {
  PolicyAuthorizer,
  allow,
  allowWhenScoped,
  authorizeScopes,
  deny,
  denyAnonymous,
} from '../src/authorizer.js';

describe('authorizeScopes', () => {
  it('allows when every required scope is held', () => {
    const p = principal('u1', { scopes: ['missions:*'] });
    expect(authorizeScopes(p, ['missions:read', 'missions:write'])).toEqual({
      allowed: true,
      reason: 'principal holds the required scopes',
    });
  });

  it('denies and names the missing scopes', () => {
    const p = principal('u1', { scopes: ['missions:read'] });
    const decision = authorizeScopes(p, ['missions:read', 'agents:write']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/agents:write/);
    expect(decision.reason).not.toMatch(/missions:read/);
  });
});

describe('PolicyAuthorizer', () => {
  const admin = principal('admin', { scopes: ['missions:write'] });

  it('allows when an allow rule matches and no deny does', () => {
    const authorizer = new PolicyAuthorizer([denyAnonymous(), allowWhenScoped()]);
    const decision = authorizer.authorize({
      principal: admin,
      action: 'missions:write',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/scoped/);
  });

  it('defaults to deny when nothing matches', () => {
    const authorizer = new PolicyAuthorizer([allowWhenScoped()]);
    const decision = authorizer.authorize({ principal: admin, action: 'agents:write' });
    expect(decision).toEqual({
      allowed: false,
      reason: 'no matching allow rule (default deny)',
    });
  });

  it('lets a deny rule override a matching allow, regardless of order', () => {
    const readOnly = deny((c) => c.resource === 'system', 'system is read-only');
    // allow first, deny second:
    const a = new PolicyAuthorizer([allowWhenScoped(), readOnly]);
    expect(
      a.authorize({ principal: admin, action: 'missions:write', resource: 'system' }),
    ).toEqual({ allowed: false, reason: 'system is read-only' });
    // deny first, allow second:
    const b = new PolicyAuthorizer([readOnly, allowWhenScoped()]);
    expect(
      b.authorize({ principal: admin, action: 'missions:write', resource: 'system' })
        .allowed,
    ).toBe(false);
  });

  it('denies the anonymous principal', () => {
    const authorizer = new PolicyAuthorizer([denyAnonymous(), allow(() => true)]);
    const decision = authorizer.authorize({ principal: anonymous, action: 'x' });
    expect(decision).toEqual({ allowed: false, reason: 'anonymous is not permitted' });
  });

  it('supports a bare allow predicate', () => {
    const authorizer = new PolicyAuthorizer([allow(() => true, 'open')]);
    expect(authorizer.authorize({ principal: anonymous, action: 'x' })).toEqual({
      allowed: true,
      reason: 'open',
    });
  });

  it('is empty-safe (default deny with no rules)', () => {
    expect(
      new PolicyAuthorizer([]).authorize({ principal: admin, action: 'x' }).allowed,
    ).toBe(false);
  });
});
