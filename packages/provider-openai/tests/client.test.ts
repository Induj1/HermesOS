/**
 * The client: request shaping and status-to-ModelError mapping.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient, HttpError } from '@hermes/tools-http';
import { OpenAIClient, safeJson } from '../src/client.js';

const clientReturning = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): OpenAIClient =>
  new OpenAIClient({
    http: new FakeHttpClient({
      handle: () => ({
        status,
        headers: { 'content-type': 'application/json', ...headers },
        body,
      }),
    }),
    apiKey: 'sk-test',
  });

describe('post', () => {
  it('sends auth and content-type, and parses JSON', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }),
    });
    const client = new OpenAIClient({
      http,
      apiKey: 'sk-x',
      baseUrl: 'https://api.openai.com/v1',
    });
    const result = await client.post<{ ok: boolean }>('/chat/completions', { a: 1 });
    expect(result.ok).toBe(true);
    const req = http.requests[0];
    expect(req?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req?.headers?.['authorization']).toBe('Bearer sk-x');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ a: 1 });
  });

  it('omits auth for a keyless local server', async () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) });
    await new OpenAIClient({ http, baseUrl: 'http://localhost:11434/v1' }).post(
      '/x',
      {},
    );
    expect(http.requests[0]?.headers?.['authorization']).toBeUndefined();
  });

  it('merges extra headers and a custom provider name', async () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) });
    const client = new OpenAIClient({
      http,
      provider: 'azure',
      headers: { 'api-key': 'k' },
    });
    expect(client.provider).toBe('azure');
    await client.post('/x', {});
    expect(http.requests[0]?.headers?.['api-key']).toBe('k');
  });
});

describe('status mapping', () => {
  const cases: readonly [number, string, string, boolean][] = [
    [401, '{}', 'AUTHENTICATION_FAILED', false],
    [403, '{}', 'AUTHENTICATION_FAILED', false],
    [404, '{}', 'MODEL_UNAVAILABLE', true],
    [429, '{}', 'RATE_LIMITED', true],
    [400, '{"error":{"message":"bad"}}', 'INVALID_REQUEST', false],
    [422, '{}', 'INVALID_REQUEST', false],
    [500, '{}', 'MODEL_UNAVAILABLE', true],
    [418, '{}', 'MODEL_ERROR', false],
  ];
  for (const [status, body, code, retryable] of cases) {
    it(`${String(status)} → ${code} (retryable=${String(retryable)})`, async () => {
      const err = await clientReturning(status, body)
        .post('/x', {})
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code, retryable });
    });
  }

  it('maps context_length_exceeded to CONTEXT_TOO_LONG', async () => {
    const err = await clientReturning(
      400,
      '{"error":{"code":"context_length_exceeded","message":"too long"}}',
    )
      .post('/x', {})
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONTEXT_TOO_LONG', retryable: false });
  });

  it('reads retry-after into RateLimitedError', async () => {
    const err = await clientReturning(429, '{}', { 'retry-after': '3' })
      .post('/x', {})
      .catch((e: unknown) => e);
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(3000);
  });

  it('surfaces the error message from the body', async () => {
    const err = await clientReturning(400, '{"error":{"message":"invalid model"}}')
      .post('/x', {})
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('invalid model');
  });
});

describe('transport mapping', () => {
  it('maps a transport TIMEOUT to MODEL_TIMEOUT (retryable)', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new HttpError('TIMEOUT', 'u', 'slow');
      },
    });
    const err = await new OpenAIClient({ http })
      .post('/x', {})
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });
  });

  it('maps another transport error to MODEL_UNAVAILABLE (retryable)', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new HttpError('NETWORK_ERROR', 'u', 'reset');
      },
    });
    const err = await new OpenAIClient({ http })
      .post('/x', {})
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
  });

  it('rethrows a non-HttpError unchanged', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new Error('bug');
      },
    });
    await expect(new OpenAIClient({ http }).post('/x', {})).rejects.toThrow('bug');
  });
});

describe('safeJson', () => {
  it('parses JSON, passes through non-JSON, and empties to undefined', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('not json')).toBe('not json');
    expect(safeJson('')).toBeUndefined();
  });
});
