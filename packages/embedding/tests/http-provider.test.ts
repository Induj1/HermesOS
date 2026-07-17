/**
 * The HTTP provider base — exercised through a concrete, OpenAI-shaped subclass
 * against a `FakeHttpClient`.
 *
 * This proves the base class does the vendor-independent work (auth headers,
 * status-to-error mapping, transport-error mapping) so a real provider supplies
 * only `buildRequest` and `parseResponse`. No network — the transport is faked.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient, HttpError, type HttpClient } from '@hermes/tools-http';
import {
  HttpEmbeddingProvider,
  type HttpEmbeddingRequest,
} from '../src/http-provider.js';
import { EmbeddingService } from '../src/service.js';
import type {
  EmbeddingBatch,
  EmbeddingBatchResponse,
  EmbeddingModel,
} from '../src/types.js';

const MODEL: EmbeddingModel = {
  name: 'text-embed-mini',
  provider: 'demo',
  dimensions: 3,
  capabilities: {
    maxBatchSize: 2,
    configurableDimensions: true,
    normalizesByDefault: true,
    costPer1kTokens: 0.00002,
  },
};

/** A minimal, OpenAI-shaped concrete provider on top of the base. */
class DemoProvider extends HttpEmbeddingProvider {
  constructor(http: HttpClient) {
    super({
      http,
      name: 'demo',
      baseUrl: 'https://api.demo.test/v1',
      models: [MODEL],
      authorization: () => 'Bearer sk-test',
    });
  }
  protected buildRequest(batch: EmbeddingBatch): HttpEmbeddingRequest {
    return {
      path: '/embeddings',
      body: { model: batch.model, input: batch.texts, dimensions: batch.dimensions },
    };
  }
  protected parseResponse(
    body: unknown,
    batch: EmbeddingBatch,
  ): EmbeddingBatchResponse {
    const data = (
      body as {
        data?: { embedding: number[] }[];
        usage?: { prompt_tokens: number; total_tokens: number };
      }
    ).data;
    if (!Array.isArray(data)) this.malformed('response has no data array');
    return {
      model: batch.model,
      dimensions: batch.dimensions,
      embeddings: data.map((d) => d.embedding),
      normalized: true,
      ...(() => {
        const usage = (
          body as { usage?: { prompt_tokens: number; total_tokens: number } }
        ).usage;
        return usage === undefined
          ? {}
          : {
              usage: {
                promptTokens: usage.prompt_tokens,
                totalTokens: usage.total_tokens,
              },
            };
      })(),
    };
  }
}

const okBody = (texts: readonly string[]): string =>
  JSON.stringify({
    data: texts.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
    usage: { prompt_tokens: texts.length * 2, total_tokens: texts.length * 2 },
  });

const batch = (texts: string[]): EmbeddingBatch => ({
  texts,
  model: 'text-embed-mini',
  dimensions: 3,
  normalize: false,
  metadata: undefined,
  signal: undefined,
  timeoutMs: undefined,
  offset: 0,
});

describe('happy path', () => {
  it('POSTs the built request with auth and parses vectors', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: okBody(['a', 'b']),
      }),
    });
    const provider = new DemoProvider(http);
    const response = await provider.embed(batch(['a', 'b']));

    expect(response.embeddings).toHaveLength(2);
    expect(response.usage).toEqual({ promptTokens: 4, totalTokens: 4 });

    const sent = http.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('https://api.demo.test/v1/embeddings');
    expect(sent?.headers?.['authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
      model: 'text-embed-mini',
      input: ['a', 'b'],
      dimensions: 3,
    });
  });

  it('works end to end through the service', async () => {
    const http = new FakeHttpClient({
      handle: (req) => {
        const input = (JSON.parse(req.body ?? '{}') as { input: string[] }).input;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: okBody(input),
        };
      },
    });
    const service = new EmbeddingService(new DemoProvider(http), {
      sleep: () => Promise.resolve(),
    });
    const response = await service.embed({ texts: ['x', 'y', 'z'] }); // maxBatchSize 2 → 2 batches
    expect(response.embeddings).toHaveLength(3);
    expect(response.batches).toBe(2);
    expect(response.normalized).toBe(true);
  });
});

describe('status-to-error mapping', () => {
  const withStatus = (
    status: number,
    headers: Record<string, string> = {},
    body = '{"error":{"message":"nope"}}',
  ) =>
    new DemoProvider(
      new FakeHttpClient({
        handle: () => ({
          status,
          headers: { 'content-type': 'application/json', ...headers },
          body,
        }),
      }),
    );

  it('401 → AUTHENTICATION_FAILED (not retryable)', async () => {
    await expect(withStatus(401).embed(batch(['a']))).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
    });
  });

  it('429 → RATE_LIMITED with retry-after', async () => {
    const err = await withStatus(429, { 'retry-after': '2' })
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(2000);
  });

  it('422 → INVALID_REQUEST (not retryable)', async () => {
    await expect(withStatus(422).embed(batch(['a']))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
    });
  });

  it('500 → PROVIDER_ERROR (retryable)', async () => {
    await expect(withStatus(500).embed(batch(['a']))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
    });
  });

  it('an unexpected 3xx-ish status → PROVIDER_ERROR (not retryable)', async () => {
    await expect(withStatus(418).embed(batch(['a']))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: false,
    });
  });

  it('403 → AUTHENTICATION_FAILED', async () => {
    await expect(withStatus(403).embed(batch(['a']))).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('429 without a retry-after has no retryAfterMs', async () => {
    const err = await withStatus(429)
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  });

  it('reads a message from a top-level string error, a nested message, or a message field', async () => {
    const a = await withStatus(500, {}, '{"error":"flat string"}')
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect((a as Error).message).toContain('flat string');
    const b = await withStatus(500, {}, '{"message":"top message"}')
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect((b as Error).message).toContain('top message');
    const c = await withStatus(500, {}, 'not json at all')
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect((c as Error).message).toContain('server error');
  });

  it('falls back to a default message when the body carries none', async () => {
    const bad = await withStatus(400, {}, '')
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect((bad as Error).message).toContain('bad request');
    const weird = await withStatus(418, {}, '')
      .embed(batch(['a']))
      .catch((e: unknown) => e);
    expect((weird as Error).message).toContain('unexpected status 418');
  });
});

describe('request construction edges', () => {
  it('propagates a batch timeout and joins a slash-less path to the base URL', async () => {
    let sentUrl: string | undefined;
    let sentTimeout: number | undefined;
    const http = new FakeHttpClient({
      handle: (req) => {
        sentUrl = req.url;
        sentTimeout = req.timeoutMs;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: okBody(['a']),
        };
      },
    });
    class Bare extends HttpEmbeddingProvider {
      constructor() {
        super({
          http,
          name: 'demo',
          baseUrl: 'https://api.demo.test/v1',
          models: [MODEL],
        });
      }
      protected buildRequest(): HttpEmbeddingRequest {
        return { path: 'embeddings', body: {} }; // no leading slash
      }
      protected parseResponse(
        _body: unknown,
        b: EmbeddingBatch,
      ): EmbeddingBatchResponse {
        return {
          model: b.model,
          dimensions: b.dimensions,
          embeddings: [[0.1, 0.2, 0.3]],
          normalized: true,
        };
      }
    }
    await new Bare().embed({ ...batch(['a']), timeoutMs: 4321 });
    expect(sentUrl).toBe('https://api.demo.test/v1/embeddings');
    expect(sentTimeout).toBe(4321);
  });

  it('uses an absolute path unchanged and omits auth when none is configured', async () => {
    let seen: string | undefined;
    let hadAuth = true;
    const http = new FakeHttpClient({
      handle: (req) => {
        seen = req.url;
        hadAuth = req.headers?.['authorization'] !== undefined;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: okBody(['a']),
        };
      },
    });
    class NoAuth extends HttpEmbeddingProvider {
      constructor() {
        super({
          http,
          name: 'demo',
          baseUrl: 'https://api.demo.test',
          models: [MODEL],
        });
      }
      protected buildRequest(): HttpEmbeddingRequest {
        return { path: 'https://other.host/v2/embeddings', body: {} };
      }
      protected parseResponse(
        _body: unknown,
        b: EmbeddingBatch,
      ): EmbeddingBatchResponse {
        return {
          model: b.model,
          dimensions: b.dimensions,
          embeddings: [[0.1, 0.2, 0.3]],
          normalized: true,
        };
      }
    }
    await new NoAuth().embed(batch(['a']));
    expect(seen).toBe('https://other.host/v2/embeddings');
    expect(hadAuth).toBe(false);
  });
});

describe('transport-error and malformed mapping', () => {
  it('a transport timeout → EmbeddingTimeoutError', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new HttpError('TIMEOUT', 'https://api.demo.test', 'timed out');
      },
    });
    await expect(new DemoProvider(http).embed(batch(['a']))).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('a transport network error → retryable PROVIDER_ERROR', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new HttpError('NETWORK_ERROR', 'https://api.demo.test', 'reset');
      },
    });
    await expect(new DemoProvider(http).embed(batch(['a']))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
    });
  });

  it('a body with no data array → MALFORMED_RESPONSE', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"unexpected":true}',
      }),
    });
    await expect(new DemoProvider(http).embed(batch(['a']))).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('rethrows a non-HttpError transport failure unchanged', async () => {
    const http = new FakeHttpClient({
      handle: () => {
        throw new Error('kaboom');
      },
    });
    await expect(new DemoProvider(http).embed(batch(['a']))).rejects.toThrow('kaboom');
  });
});
