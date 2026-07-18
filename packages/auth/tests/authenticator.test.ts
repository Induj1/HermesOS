/**
 * Authenticators — constant-time compare, API-key lookup, and the chain.
 */

import { describe, expect, it } from 'vitest';
import {
  ApiKeyAuthenticator,
  ChainAuthenticator,
  constantTimeEqual,
  type AuthResult,
  type Authenticator,
} from '../src/authenticator.js';
import { principal } from '../src/principal.js';

describe('constantTimeEqual', () => {
  it('is true for equal strings and false otherwise', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('is false for different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('ApiKeyAuthenticator', () => {
  const admin = principal('admin', { kind: 'service', scopes: ['w'] });

  it('resolves a known key to its principal (record form)', async () => {
    const auth = new ApiKeyAuthenticator({ 'sk-admin': admin });
    const result = await auth.authenticate('sk-admin');
    expect(result).toEqual({ ok: true, principal: admin });
  });

  it('accepts a Map of keys', async () => {
    const auth = new ApiKeyAuthenticator(new Map([['sk-admin', admin]]));
    expect((await auth.authenticate('sk-admin')).ok).toBe(true);
  });

  it('rejects an unknown key uniformly', async () => {
    const auth = new ApiKeyAuthenticator({ 'sk-admin': admin });
    const result = await auth.authenticate('sk-nope');
    expect(result).toEqual({ ok: false, reason: 'invalid credentials' });
  });
});

/** A stub authenticator with a fixed answer, for chain tests. */
function stub(answer: AuthResult): Authenticator {
  return { authenticate: () => Promise.resolve(answer) };
}

describe('ChainAuthenticator', () => {
  const user = principal('u1');

  it('returns the first success', async () => {
    const chain = new ChainAuthenticator([
      stub({ ok: false, reason: 'first' }),
      stub({ ok: true, principal: user }),
      stub({ ok: false, reason: 'never reached' }),
    ]);
    expect(await chain.authenticate('x')).toEqual({ ok: true, principal: user });
  });

  it('reports the last failure reason when all reject', async () => {
    const chain = new ChainAuthenticator([
      stub({ ok: false, reason: 'first' }),
      stub({ ok: false, reason: 'second' }),
    ]);
    expect(await chain.authenticate('x')).toEqual({ ok: false, reason: 'second' });
  });

  it('reports a default reason for an empty chain', async () => {
    const result = await new ChainAuthenticator([]).authenticate('x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no authenticator/);
  });
});
