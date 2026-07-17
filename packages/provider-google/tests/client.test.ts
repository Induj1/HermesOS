/**
 * The Gemini client: header shaping and the context-length override.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient } from '@hermes/tools-http';
import { GoogleClient } from '../src/client.js';

describe('GoogleClient', () => {
  it('sends the key as x-goog-api-key and joins the path', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    });
    await new GoogleClient({ http, apiKey: 'g-key' }).post(
      '/models/x:generateContent',
      { a: 1 },
    );
    const req = http.requests[0];
    expect(req?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
    );
    expect(req?.headers?.['x-goog-api-key']).toBe('g-key');
  });

  it('omits the key when none is given and joins a slash-less path', async () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) });
    await new GoogleClient({ http, baseUrl: 'https://host/v1' }).post(
      'models/x:generateContent',
      {},
    );
    expect(http.requests[0]?.url).toBe('https://host/v1/models/x:generateContent');
    expect(http.requests[0]?.headers?.['x-goog-api-key']).toBeUndefined();
  });

  it('uses the shared classifier for standard statuses', async () => {
    const client = (status: number, body = '{}'): GoogleClient =>
      new GoogleClient({
        http: new FakeHttpClient({
          handle: () => ({
            status,
            headers: { 'content-type': 'application/json' },
            body,
          }),
        }),
        apiKey: 'k',
      });
    await expect(client(429).post('/x', {})).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    await expect(client(401).post('/x', {})).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    await expect(client(503).post('/x', {})).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      retryable: true,
    });
  });

  it('maps a token-limit message to CONTEXT_TOO_LONG', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: '{"error":{"message":"The input token count exceeds the maximum"}}',
      }),
    });
    await expect(
      new GoogleClient({ http, apiKey: 'k' }).post('/x', {}),
    ).rejects.toMatchObject({ code: 'CONTEXT_TOO_LONG' });
  });

  it('maps an ordinary 400 to INVALID_REQUEST', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: '{"error":{"message":"bad field"}}',
      }),
    });
    await expect(
      new GoogleClient({ http, apiKey: 'k' }).post('/x', {}),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
