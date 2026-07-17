/**
 * Compatibility with `@hermes/model`'s `EmbeddingModel`.
 *
 * The model-contracts package (and, through a matching interface,
 * `@hermes/memory`) already declares a minimal embedder: `embed(texts, signal)`
 * returning vectors, plus `model`, `dimensions`, and a `ModelInfo`. The whole
 * platform's batching, retries, and concurrency should be usable *anywhere that
 * seam is expected* — a `MemoryService`, a future model router — without a caller
 * knowing this package exists.
 *
 * {@link toModelEmbedding} is that bridge: it wraps an {@link EmbeddingService} as
 * a `@hermes/model` `EmbeddingModel`. So a host builds one `EmbeddingService` with
 * all its policy, and hands the *adapter* to memory — which gets pooled, retried,
 * cost-tracked embeddings behind an interface it already understood.
 *
 * The dependency points the right way: this package depends on the contracts, not
 * the other way round.
 */

import type { EmbeddingModel as ModelEmbeddingModel } from '@hermes/model';
import type { EmbeddingService } from './service.js';

/**
 * Adapt an {@link EmbeddingService} to a `@hermes/model` `EmbeddingModel`.
 *
 * The returned object's `embed` runs the full service pipeline (batching, retries,
 * concurrency) but presents the minimal contract memory and the router consume.
 * `model` selects which of the provider's models the adapter is bound to; it
 * defaults to the provider's first.
 */
export function toModelEmbedding(
  service: EmbeddingService,
  model?: string,
): ModelEmbeddingModel {
  const models = service.models();
  const chosen = model === undefined ? models[0] : models.find((m) => m.name === model);
  if (chosen === undefined) {
    throw new Error(`embedding service does not serve model "${model ?? '(default)'}"`);
  }

  return {
    info: {
      name: chosen.name,
      provider: chosen.provider,
      // An embedder is not a chat/tools/streaming model; say so honestly so a
      // router never tries to converse with it.
      supports: { chat: false, tools: false, streaming: false },
    },
    model: chosen.name,
    dimensions: chosen.dimensions,
    embed: async (texts, signal) => {
      const response = await service.embed({
        texts,
        model: chosen.name,
        ...(signal === undefined ? {} : { signal }),
      });
      return response.embeddings;
    },
  };
}
