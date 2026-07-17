/**
 * The Anthropic client: request shaping and status-to-ModelError mapping.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient, HttpError } from '@hermes/tools-http';
import { AnthropicClient, safeJson } from '../src/client.js';

const clientReturning = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): AnthropicClient =>
  new AnthropicClient({
    http: new FakeHttpClient({
      handle: () => ({
        status,
        headers: { 'content-type': 'application/json', ...headers },
        body,
      }),
    }),
    apiKey: 'sk-ant',
  });

describe('post', () => {
  it('sends x-api-key and anthropic-version', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }),
    });
    await new AnthropicClient({ http, apiKey: 'sk-x' }).post('/messages', { a: 1 });
    const req = http.requests[0];
    expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req?.headers?.['x-api-key']).toBe('sk-x');
    expect(req?.headers?.['anthropic-version']).toBe('2023-06-01');
  });

  it('omits the key when none is given and honours a custom version', async () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) });
    await new AnthropicClient({ http, version: '2099-01-01' }).post('/x', {});
    expect(http.requests[0]?.headers?.['x-api-key']).toBeUndefined();
    expect(http.requests[0]?.headers?.['anthropic-version']).toBe('2099-01-01');
  });

  it('joins a slash-less path to the base URL', async () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) });
    await new AnthropicClient({ http }).post('messages', {});
    expect(http.requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('status mapping', () => {
  const cases: readonly [number, string, boolean][] = [
    [401, 'AUTHENTICATION_FAILED', false],
    [403, 'AUTHENTICATION_FAILED', false],
    [404, 'MODEL_UNAVAILABLE', true],
    [429, 'RATE_LIMITED', true],
    [400, 'INVALID_REQUEST', false],
    [500, 'MODEL_UNAVAILABLE', true],
    [529, 'MODEL_UNAVAILABLE', true],
    [418, 'MODEL_ERROR', false],
  ];
  for (const [status, code, retryable] of cases) {
    it(`${String(status)} → ${code}`, async () => {
      const err = await clientReturning(status, '{}')
        .post('/x', {})
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code, retryable });
    });
  }

  it('maps a too-long prompt to CONTEXT_TOO_LONG', async () => {
    const err = await clientReturning(
      400,
      '{"error":{"message":"prompt is too long: 250000 tokens"}}',
    )
      .post('/x', {})
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONTEXT_TOO_LONG' });
  });

  it('reads retry-after and surfaces the error message', async () => {
    const rate = await clientReturning(429, '{}', { 'retry-after': '5' })
      .post('/x', {})
      .catch((e: unknown) => e);
    expect((rate as { retryAfterMs?: number }).retryAfterMs).toBe(5000);
    const invalid = await clientReturning(400, '{"error":{"message":"bad model"}}')
      .post('/x', {})
      .catch((e: unknown) => e);
    expect((invalid as Error).message).toContain('bad model');
  });
});

describe('transport mapping', () => {
  it('maps TIMEOUT and other transport faults', async () => {
    const timeout = new AnthropicClient({
      http: new FakeHttpClient({
        handle: () => {
          throw new HttpError('TIMEOUT', 'u', 'x');
        },
      }),
    });
    await expect(timeout.post('/x', {})).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
    });
    const net = new AnthropicClient({
      http: new FakeHttpClient({
        handle: () => {
          throw new HttpError('NETWORK_ERROR', 'u', 'x');
        },
      }),
    });
    await expect(net.post('/x', {})).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      retryable: true,
    });
  });

  it('rethrows a non-HttpError', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new Error('bug');
      },
    });
    await expect(new AnthropicClient({ http }).post('/x', {})).rejects.toThrow('bug');
  });
});

describe('safeJson', () => {
  it('parses, passes through, and empties', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('x')).toBe('x');
    expect(safeJson('')).toBeUndefined();
  });
});
