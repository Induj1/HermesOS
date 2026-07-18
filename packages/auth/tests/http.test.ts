/**
 * The HTTP boundary — bearer extraction and header-based authentication.
 */

import { describe, expect, it } from 'vitest';
import { ApiKeyAuthenticator } from '../src/authenticator.js';
import { authenticateHeaders, extractBearer } from '../src/http.js';
import { principal } from '../src/principal.js';

describe('extractBearer', () => {
  it('pulls the token from a Bearer header, case-insensitively', () => {
    expect(extractBearer('Bearer sk-1')).toBe('sk-1');
    expect(extractBearer('bearer   sk-2')).toBe('sk-2');
    expect(extractBearer('  Bearer sk-3  ')).toBe('sk-3');
  });

  it('returns undefined for a missing or non-bearer header', () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer('Bearer')).toBeUndefined();
    expect(extractBearer('Bearer ')).toBeUndefined();
  });
});

describe('authenticateHeaders', () => {
  const user = principal('u1', { scopes: ['read'] });
  const auth = new ApiKeyAuthenticator({ 'sk-user': user });

  it('authenticates a valid bearer token', async () => {
    const result = await authenticateHeaders(auth, { Authorization: 'Bearer sk-user' });
    expect(result).toEqual({ ok: true, principal: user });
  });

  it('finds the header regardless of case', async () => {
    const result = await authenticateHeaders(auth, { authorization: 'Bearer sk-user' });
    expect(result.ok).toBe(true);
  });

  it('fails when the header is absent', async () => {
    const result = await authenticateHeaders(auth, {});
    expect(result).toEqual({ ok: false, reason: 'missing bearer credentials' });
  });

  it('fails when the token is unknown', async () => {
    const result = await authenticateHeaders(auth, { Authorization: 'Bearer wrong' });
    expect(result).toEqual({ ok: false, reason: 'invalid credentials' });
  });
});
