/**
 * The OpenAI embedding provider — against a fake HTTP client, end to end through
 * the embedding service.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient, type FakeHandler } from '@hermes/tools-http';
import { EmbeddingService } from '@hermes/embedding';
import { OpenAIEmbeddingProvider } from '../src/embeddings.js';

const embeddingBody = (vectors: number[][], indices?: number[]): string =>
  JSON.stringify({
    object: 'list',
    data: vectors.map((embedding, i) => ({
      object: 'embedding',
      embedding,
      index: indices?.[i] ?? i,
    })),
    usage: { prompt_tokens: 8, total_tokens: 8 },
  });

const providerWith = (handle: FakeHandler): OpenAIEmbeddingProvider =>
  new OpenAIEmbeddingProvider({ http: new FakeHttpClient({ handle }), apiKey: 'sk-x' });

describe('OpenAIEmbeddingProvider', () => {
  it('declares OpenAI models with capabilities', () => {
    const provider = new OpenAIEmbeddingProvider({
      http: new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) }),
    });
    const names = provider.models().map((m) => m.name);
    expect(names).toContain('text-embedding-3-small');
    expect(provider.capabilities('text-embedding-3-small').normalizesByDefault).toBe(
      true,
    );
  });

  it('builds an OpenAI request and parses vectors, sorting by index', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: embeddingBody([[0.9], [0.1]], [1, 0]),
      }),
    });
    const provider = new OpenAIEmbeddingProvider({
      http,
      apiKey: 'sk-x',
      models: [
        {
          name: 'm',
          provider: 'openai',
          dimensions: 1,
          capabilities: {
            maxBatchSize: 8,
            configurableDimensions: true,
            normalizesByDefault: true,
          },
        },
      ],
    });
    const service = new EmbeddingService(provider, { sleep: () => Promise.resolve() });

    const response = await service.embed({ texts: ['a', 'b'] });
    // Server returned index 1 then 0; provider sorts by index so alignment holds.
    expect(response.embeddings).toEqual([[0.1], [0.9]]);

    const sent = JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'm', input: ['a', 'b'], dimensions: 1 });
    expect(http.requests[0]?.headers?.['authorization']).toBe('Bearer sk-x');
  });

  it('reports usage', async () => {
    const provider = new OpenAIEmbeddingProvider({
      http: new FakeHttpClient({
        handle: () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: embeddingBody([[0.1, 0.2, 0.3]]),
        }),
      }),
      apiKey: 'k',
      models: [
        {
          name: 'm',
          provider: 'openai',
          dimensions: 3,
          capabilities: {
            maxBatchSize: 8,
            configurableDimensions: false,
            normalizesByDefault: true,
          },
        },
      ],
    });
    const response = await new EmbeddingService(provider).embed({ texts: ['x'] });
    expect(response.usage?.totalTokens).toBe(8);
  });

  it('raises a malformed error when there is no data array', async () => {
    const provider = new OpenAIEmbeddingProvider({
      http: new FakeHttpClient({
        handle: () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"unexpected":1}',
        }),
      }),
      apiKey: 'k',
    });
    const service = new EmbeddingService(provider, {
      sleep: () => Promise.resolve(),
      retries: 0,
    });
    await expect(service.embed({ texts: ['x'] })).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('surfaces a 429 as a retryable rate limit through the service retry', async () => {
    let calls = 0;
    const provider = providerWith(() => {
      calls += 1;
      if (calls === 1)
        return {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
          body: '{}',
        };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: embeddingBody([[0.1]]),
      };
    });
    const service = new EmbeddingService(provider, {
      sleep: () => Promise.resolve(),
      retries: 2,
    });
    const response = await service.embed({
      texts: ['x'],
      model: 'text-embedding-3-small',
      dimensions: 1,
    });
    expect(response.embeddings).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('omits usage when the response carries none', async () => {
    const body = JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] });
    const provider = new OpenAIEmbeddingProvider({
      http: new FakeHttpClient({
        handle: () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
        }),
      }),
      apiKey: 'k',
      models: [
        {
          name: 'm',
          provider: 'openai',
          dimensions: 3,
          capabilities: {
            maxBatchSize: 8,
            configurableDimensions: false,
            normalizesByDefault: true,
          },
        },
      ],
    });
    const response = await new EmbeddingService(provider).embed({ texts: ['x'] });
    expect(response.usage).toBeUndefined();
  });

  it('reports whether a key was supplied', () => {
    expect(
      new OpenAIEmbeddingProvider({
        http: new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) }),
        apiKey: 'k',
      }).hasKey,
    ).toBe(true);
    expect(
      new OpenAIEmbeddingProvider({
        http: new FakeHttpClient({ handle: () => ({ status: 200, body: '{}' }) }),
      }).hasKey,
    ).toBe(false);
  });
});
