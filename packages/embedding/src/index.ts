/**
 * @hermes/embedding — a provider-independent embedding platform.
 *
 * A provider turns one batch of texts into vectors; the {@link EmbeddingService}
 * wraps any provider and adds everything that makes embedding safe and efficient
 * at scale — batching to the provider's limit, a bounded-concurrency pool,
 * retries with backoff, deterministic input-order results, cancellation and
 * timeout propagation, normalization, and usage/cost aggregation — uniformly, so
 * OpenAI, Ollama, Voyage, Cohere, Gemini, Azure, or a local ONNX model all behave
 * the same to a caller.
 *
 * ```ts
 * import { EmbeddingService, FakeEmbeddingProvider } from '@hermes/embedding';
 *
 * const service = new EmbeddingService(new FakeEmbeddingProvider(), { maxConcurrency: 8 });
 * const { embeddings, usage, cost } = await service.embed({ texts, normalize: true });
 * ```
 *
 * To plug a real backend, implement {@link EmbeddingProvider} — or extend
 * {@link HttpEmbeddingProvider}, which reuses `@hermes/tools-http` for transport.
 * To use the platform where a `@hermes/model` embedder is expected (memory, a
 * router), wrap the service with {@link toModelEmbedding}.
 *
 * See `docs/rfcs/RFC-0013-embedding-service.md` for the design.
 */

export { EmbeddingService } from './service.js';
export type { EmbeddingServiceOptions } from './service.js';

export { resolveModel } from './provider.js';
export type { EmbeddingProvider } from './provider.js';

export { FakeEmbeddingProvider } from './fake-provider.js';
export type { FakeEmbeddingOptions, FakeFault } from './fake-provider.js';

export { HttpEmbeddingProvider } from './http-provider.js';
export type {
  HttpEmbeddingProviderOptions,
  HttpEmbeddingRequest,
} from './http-provider.js';

export { toModelEmbedding } from './compat.js';

export { l2normalize, assertVector, assertBatch } from './normalize.js';

export {
  EmbeddingError,
  RateLimitedError,
  EmbeddingTimeoutError,
  EmbeddingCancelledError,
  UnknownModelError,
  InvalidRequestError,
  MalformedResponseError,
  DimensionMismatchError,
  AuthenticationFailedError,
  isRetryable,
  toError,
} from './errors.js';
export type { EmbeddingErrorCode } from './errors.js';

export type {
  Embedding,
  EmbeddingModel,
  EmbeddingCapabilities,
  ProviderInfo,
  EmbeddingRequest,
  EmbeddingBatch,
  EmbeddingBatchResponse,
  EmbeddingResponse,
  EmbeddingUsage,
  EmbeddingCost,
} from './types.js';
