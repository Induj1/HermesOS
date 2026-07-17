/**
 * The auth abstraction: static tokens, and the App installation-token cache.
 *
 * The static cases are trivial by design. The one with logic is `appAuth`, whose
 * job is to refresh an expiring token without stampeding — so those tests drive a
 * fake clock and a counting `mint` and assert on when it is (and is not) called.
 */

import { describe, expect, it, vi } from 'vitest';
import { tokenAuth, unauthenticated, appAuth } from '../src/auth.js';
import type { InstallationToken } from '../src/auth.js';

describe('tokenAuth', () => {
  it('sends a Bearer authorization', async () => {
    expect(await tokenAuth('ghp_x').headers()).toEqual({
      authorization: 'Bearer ghp_x',
    });
  });

  it('rejects an empty token', () => {
    expect(() => tokenAuth('')).toThrow(/non-empty/);
  });
});

describe('unauthenticated', () => {
  it('sends no authorization', async () => {
    expect(await unauthenticated().headers()).toEqual({ authorization: undefined });
  });
});

describe('appAuth', () => {
  const token = (t: string, expiresAt: number): InstallationToken => ({
    token: t,
    expiresAt,
  });

  it('mints on first use and caches while fresh', async () => {
    let clock = 0;
    const mint = vi.fn(() => Promise.resolve(token('t1', 1_000_000)));
    const auth = appAuth({ mint, now: () => clock });

    expect((await auth.headers()).authorization).toBe('Bearer t1');
    clock = 500_000;
    expect((await auth.headers()).authorization).toBe('Bearer t1');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the token is within the skew of expiry', async () => {
    let clock = 0;
    const mint = vi
      .fn<() => Promise<InstallationToken>>()
      .mockResolvedValueOnce(token('t1', 100_000))
      .mockResolvedValueOnce(token('t2', 200_000));
    const auth = appAuth({ mint, now: () => clock, refreshSkewMs: 10_000 });

    expect((await auth.headers()).authorization).toBe('Bearer t1');
    // 95s: within 10s of the 100s expiry, so a refresh is due.
    clock = 95_000;
    expect((await auth.headers()).authorization).toBe('Bearer t2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight mint across concurrent callers', async () => {
    let resolve!: (t: InstallationToken) => void;
    const mint = vi.fn(() => new Promise<InstallationToken>((r) => (resolve = r)));
    const auth = appAuth({ mint, now: () => 0 });

    const a = auth.headers();
    const b = auth.headers();
    resolve(token('shared', 1_000_000));

    expect(await a).toEqual({ authorization: 'Bearer shared' });
    expect(await b).toEqual({ authorization: 'Bearer shared' });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('uses the real clock when none is injected', async () => {
    const mint = vi.fn(() => Promise.resolve(token('t', Date.now() + 3_600_000)));
    const auth = appAuth({ mint });
    expect((await auth.headers()).authorization).toBe('Bearer t');
    // Still fresh a moment later — the real clock has barely moved.
    expect((await auth.headers()).authorization).toBe('Bearer t');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('re-mints after a failed refresh', async () => {
    const mint = vi
      .fn<() => Promise<InstallationToken>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(token('t2', 1_000_000));
    const auth = appAuth({ mint, now: () => 0 });

    await expect(auth.headers()).rejects.toThrow('network');
    expect((await auth.headers()).authorization).toBe('Bearer t2');
  });
});
