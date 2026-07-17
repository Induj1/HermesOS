/**
 * Webhook verification — the security-critical corner of the package.
 *
 * These pin the three things that make it correct: the HMAC matches a
 * known-good signature, a wrong secret or tampered body is rejected, and
 * `parseWebhook` refuses to parse an unverified body.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, parseWebhook } from '../src/webhooks.js';

const sign = (body: string, secret: string): string =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ action: 'opened' });
  const secret = 'topsecret';

  it('accepts a correct signature', () => {
    expect(verifyWebhookSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'wrong'), secret)).toBe(false);
  });

  it('rejects when the body was tampered with', () => {
    expect(verifyWebhookSignature(body + ' ', sign(body, secret), secret)).toBe(false);
  });

  it('rejects a missing or unprefixed header', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'deadbeef', secret)).toBe(false);
  });

  it('rejects a prefixed signature of the wrong length', () => {
    // Passes the prefix check, but is too short to be a SHA-256 hex digest, so the
    // length guard (before the constant-time compare, which throws on mismatch)
    // rejects it.
    expect(verifyWebhookSignature(body, 'sha256=abcd', secret)).toBe(false);
  });

  it('rejects a same-length but wrong signature (constant-time path)', () => {
    const good = sign(body, secret);
    const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    expect(verifyWebhookSignature(body, bad, secret)).toBe(false);
  });
});

describe('parseWebhook', () => {
  const secret = 'topsecret';
  const payload = { action: 'opened', number: 1 };
  const body = JSON.stringify(payload);

  it('verifies, then parses into a typed event', () => {
    const event = parseWebhook(
      body,
      {
        'x-hub-signature-256': sign(body, secret),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'guid-1',
      },
      secret,
    );
    expect(event).toEqual({ name: 'pull_request', delivery: 'guid-1', payload });
  });

  it('throws on a bad signature before parsing', () => {
    expect(() =>
      parseWebhook(
        body,
        { 'x-hub-signature-256': sign(body, 'wrong'), 'x-github-event': 'push' },
        secret,
      ),
    ).toThrow(/signature verification failed/);
  });

  it('throws when the event name is missing', () => {
    expect(() =>
      parseWebhook(body, { 'x-hub-signature-256': sign(body, secret) }, secret),
    ).toThrow(/X-GitHub-Event/);
  });

  it('defaults the delivery id to empty when absent', () => {
    const event = parseWebhook(
      body,
      { 'x-hub-signature-256': sign(body, secret), 'x-github-event': 'push' },
      secret,
    );
    expect(event.delivery).toBe('');
  });

  it('throws on a verified-but-invalid JSON body', () => {
    const bad = '{not json';
    expect(() =>
      parseWebhook(
        bad,
        { 'x-hub-signature-256': sign(bad, secret), 'x-github-event': 'push' },
        secret,
      ),
    ).toThrow(/not valid JSON/);
  });
});
