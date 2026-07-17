/**
 * The provider contract — the one interface every backend implements.
 *
 * A provider is thin by design. It does **not** batch (the service sizes batches
 * to `maxBatchSize` and hands them over one at a time), it does **not** retry
 * (the service owns the retry policy so it is uniform across providers), and it
 * does **not** normalize unless it natively does. Its whole job is: declare what
 * its models can do, and turn one {@link EmbeddingBatch} into vectors, honouring
 * cancellation and timeout.
 *
 * Keeping those cross-cutting concerns in the service — not the provider — is what
 * makes adding OpenAI, Ollama, Voyage, Cohere, Gemini, or a local ONNX model a
 * matter of implementing this small surface, with batching/retry/concurrency
 * behaving identically for all of them.
 */

import { UnknownModelError } from './errors.js';
import type {
  EmbeddingBatch,
  EmbeddingBatchResponse,
  EmbeddingCapabilities,
  EmbeddingModel,
  ProviderInfo,
} from './types.js';

export interface EmbeddingProvider {
  readonly info: ProviderInfo;
  /** The models this provider serves. A router and a caller read this to choose. */
  models(): readonly EmbeddingModel[];
  /**
   * Capabilities for a model, or the provider's default model when `model` is
   * omitted. Throws {@link UnknownModelError} for a model it does not serve.
   */
  capabilities(model?: string): EmbeddingCapabilities;
  /**
   * Embed one batch — already sized to `maxBatchSize` by the service — returning
   * one vector per text, in order. Must honour `batch.signal` and `batch.timeoutMs`.
   */
  embed(batch: EmbeddingBatch): Promise<EmbeddingBatchResponse>;
}

/**
 * Resolve a model descriptor from a provider, defaulting to its first model.
 *
 * The shared lookup the service and adapters use, so "which model, and does it
 * exist" is answered one way. Throws {@link UnknownModelError} rather than
 * returning undefined, because a caller that named a model wants to know it was
 * wrong, not silently get a different one.
 */
export function resolveModel(
  provider: EmbeddingProvider,
  model?: string,
): EmbeddingModel {
  const models = provider.models();
  if (model === undefined) {
    const first = models[0];
    if (first === undefined) {
      throw new UnknownModelError(provider.info.name, '(default)');
    }
    return first;
  }
  const found = models.find((m) => m.name === model);
  if (found === undefined) {
    throw new UnknownModelError(provider.info.name, model);
  }
  return found;
}
