/**
 * The App JWT signer and installation-token exchange.
 *
 * The JWT is signed with a generated RSA key pair — no real App credential — and
 * verified with the public key, which proves the signing is genuine RS256 over
 * the right input, not just a plausible-looking string. The exchange is driven
 * against the fake server.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, installationTokenMinter } from '../src/app-jwt.js';
import { GitHubClient } from '../src/client.js';
import { FakeGitHubServer } from '../src/fake-server.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const decode = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString()) as Record<string, unknown>;

describe('appJwt', () => {
  it('produces a three-part token signed over header.payload', () => {
    const jwt = appJwt({ appId: 123, privateKey: pem, now: () => 1_000_000_000_000 });
    const [header = '', payload = '', signature = ''] = jwt.split('.');
    expect(header && payload && signature).toBeTruthy();

    const verify = createVerify('RSA-SHA256').update(`${header}.${payload}`).end();
    expect(verify.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('sets iss, a backdated iat, and a 10-minute exp', () => {
    const nowMs = 1_000_000_000_000;
    const jwt = appJwt({ appId: '456', privateKey: pem, now: () => nowMs });
    const claims = decode(jwt.split('.')[1] ?? '');
    const nowSec = Math.floor(nowMs / 1000);
    expect(claims['iss']).toBe('456');
    expect(claims['iat']).toBe(nowSec - 60);
    expect(claims['exp']).toBe(nowSec + 600);
  });
});

describe('installationTokenMinter', () => {
  it('exchanges a JWT for an installation token with a parsed expiry', async () => {
    const server = new FakeGitHubServer();
    const client = new GitHubClient({ http: server, userAgent: 'test' });
    const mint = installationTokenMinter(client, {
      appId: 1,
      installationId: 99,
      privateKey: pem,
    });

    const token = await mint();
    expect(token.token).toBe('ghs_fake_installation_token');
    expect(token.expiresAt).toBe(Date.parse('2099-01-01T00:00:00Z'));

    // It authenticated the exchange as the App, with a signed JWT.
    const call = server.requests.at(-1);
    expect(call?.url).toContain('/app/installations/99/access_tokens');
    expect(call?.headers['authorization']).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('forwards an abort signal to the exchange', async () => {
    const server = new FakeGitHubServer();
    const client = new GitHubClient({ http: server, userAgent: 'test' });
    const mint = installationTokenMinter(client, {
      appId: 1,
      installationId: 1,
      privateKey: pem,
    });
    const controller = new AbortController();
    await mint(controller.signal);
    expect(server.requests.at(-1)?.method).toBe('POST');
  });

  it('treats an unparseable expiry as already stale (expiresAt 0)', async () => {
    const server = new FakeGitHubServer();
    server.forceNext({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: { token: 't', expires_at: 'not-a-date' },
    });
    const client = new GitHubClient({ http: server, userAgent: 'test' });
    const mint = installationTokenMinter(client, {
      appId: 1,
      installationId: 1,
      privateKey: pem,
    });
    expect((await mint()).expiresAt).toBe(0);
  });
});
