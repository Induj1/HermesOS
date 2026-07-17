/**
 * The `@hermes/model` compatibility adapter.
 *
 * Proves an EmbeddingService presents as a `@hermes/model` `EmbeddingModel` — the
 * seam memory and a future router consume — while running the full pipeline
 * underneath.
 */

import { describe, expect, it } from 'vitest';
import { EmbeddingService } from '../src/service.js';
import { FakeEmbeddingProvider } from '../src/fake-provider.js';
import { toModelEmbedding } from '../src/compat.js';

describe('toModelEmbedding', () => {
  it('adapts the service to the model contract', async () => {
    const service = new EmbeddingService(new FakeEmbeddingProvider(), {
      sleep: () => Promise.resolve(),
    });
    const model = toModelEmbedding(service);

    expect(model.model).toBe('fake-embed-3');
    expect(model.dimensions).toBe(8);
    expect(model.info).toMatchObject({
      provider: 'fake',
      supports: { chat: false, tools: false, streaming: false },
    });

    const vectors = await model.embed(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(8);
  });

  it('runs the batching pipeline underneath the minimal interface', async () => {
    const provider = new FakeEmbeddingProvider(); // maxBatchSize 4
    const service = new EmbeddingService(provider, { sleep: () => Promise.resolve() });
    const model = toModelEmbedding(service);

    await model.embed(Array.from({ length: 9 }, (_, i) => `t${String(i)}`));
    expect(provider.calls).toHaveLength(3); // 4 + 4 + 1 — the service batched
  });

  it('binds to a named model', () => {
    const provider = new FakeEmbeddingProvider({
      models: [
        {
          name: 'a',
          provider: 'fake',
          dimensions: 8,
          capabilities: {
            maxBatchSize: 4,
            configurableDimensions: false,
            normalizesByDefault: false,
          },
        },
        {
          name: 'b',
          provider: 'fake',
          dimensions: 16,
          capabilities: {
            maxBatchSize: 4,
            configurableDimensions: false,
            normalizesByDefault: false,
          },
        },
      ],
    });
    const model = toModelEmbedding(new EmbeddingService(provider), 'b');
    expect(model.dimensions).toBe(16);
  });

  it('throws for a model the provider does not serve', () => {
    const service = new EmbeddingService(new FakeEmbeddingProvider());
    expect(() => toModelEmbedding(service, 'ghost')).toThrow(/does not serve/);
  });

  it('throws for a default when the provider serves no models', () => {
    const service = new EmbeddingService(new FakeEmbeddingProvider({ models: [] }));
    expect(() => toModelEmbedding(service)).toThrow(/does not serve/);
  });

  it('forwards an abort signal', async () => {
    const service = new EmbeddingService(new FakeEmbeddingProvider());
    const model = toModelEmbedding(service);
    await expect(model.embed(['a'], AbortSignal.abort())).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
});
