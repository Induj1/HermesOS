/**
 * GitHub App authentication: the JWT, and the installation-token exchange.
 *
 * A GitHub App does not have a token. It has an RSA private key, and it proves its
 * identity by signing a short-lived JWT (RS256) with that key. It then trades the
 * JWT for an *installation* token — the thing that actually authorizes API calls —
 * which expires in an hour. {@link appAuth} handles the caching and refresh of
 * that installation token; this module supplies the two credential-bound pieces
 * it needs: minting the JWT, and exchanging it.
 *
 * The JWT signing is pure given a key and a clock, so it is unit-tested against a
 * generated test key pair with no real credential. The exchange is a normal API
 * call through {@link GitHubClient}, testable against the fake server. What cannot
 * be tested without a real App is the *pair* working end to end against GitHub —
 * that is the credential-gated part, called out in the RFC.
 */

import { createSign } from 'node:crypto';
import type { GitHubClient } from './client.js';
import type { InstallationToken } from './auth.js';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface AppJwtOptions {
  /** The App's numeric ID (its `iss` claim). */
  readonly appId: string | number;
  /** The App's RSA private key, PEM-encoded. */
  readonly privateKey: string;
  /** Clock in epoch ms, injectable for tests. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Mint a signed App JWT, valid for ten minutes.
 *
 * The `iat` is backdated sixty seconds to tolerate clock skew between this host
 * and GitHub — GitHub rejects a JWT whose `iat` is in its future, and a
 * fast-running local clock is the most common cause of an otherwise-correct App
 * failing to authenticate. The `exp` is the maximum GitHub allows (10 minutes);
 * the JWT is only ever used immediately to fetch an installation token, so a
 * short life costs nothing.
 */
export function appJwt(options: AppJwtOptions): string {
  const nowSec = Math.floor((options.now ?? (() => Date.now()))() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: String(options.appId) }),
  );
  const signingInput = `${header}.${payload}`;

  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .end()
    .sign(options.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export interface InstallationMinterOptions extends AppJwtOptions {
  /** The installation to act as — one App can be installed on many accounts. */
  readonly installationId: string | number;
}

/**
 * Build a `mint` callback for {@link appAuth} that fetches installation tokens.
 *
 * Each call signs a fresh JWT, authorizes with it as the App, and POSTs to
 * `/app/installations/{id}/access_tokens`. GitHub returns a token and an ISO
 * `expires_at`, which is parsed to the epoch-ms {@link InstallationToken} the
 * refresh logic wants.
 */
export function installationTokenMinter(
  client: GitHubClient,
  options: InstallationMinterOptions,
): (signal?: AbortSignal) => Promise<InstallationToken> {
  return async (signal) => {
    const jwt = appJwt(options);
    const response = await client.request<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${String(options.installationId)}/access_tokens`,
      {
        headers: { authorization: `Bearer ${jwt}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const expiresAt = Date.parse(response.data.expires_at);
    return {
      token: response.data.token,
      // A token GitHub gave no parseable expiry for is treated as already stale,
      // forcing a refresh next call rather than trusting it indefinitely.
      expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt,
    };
  };
}
