/**
 * The OpenAI embedding provider — an {@link HttpEmbeddingProvider} subclass.
 *
 * The embedding platform (RFC-0013) already owns batching, retries, concurrency,
 * and error mapping through its HTTP base; this supplies only the two
 * vendor-specific translations — the request body and the response shape — so it
 * is a handful of lines. It is registered with an `EmbeddingService`, which is
 * what a caller actually holds.
 */

import {
  HttpEmbeddingProvider,
  type EmbeddingBatch,
  type EmbeddingBatchResponse,
  type EmbeddingModel,
  type HttpEmbeddingRequest,
} from '@hermes/embedding';
import type { HttpClient } from '@hermes/tools-http';

export interface OpenAIEmbeddingOptions {
  readonly http: HttpClient;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly userAgent?: string;
  /** The embedding models this provider serves. Defaults to OpenAI's `text-embedding-3-small`. */
  readonly models?: readonly EmbeddingModel[];
}

const DEFAULT_MODELS: readonly EmbeddingModel[] = [
  {
    name: 'text-embedding-3-small',
    provider: 'openai',
    dimensions: 1536,
    capabilities: {
      maxBatchSize: 2048,
      configurableDimensions: true,
      normalizesByDefault: true,
      costPer1kTokens: 0.00002,
    },
  },
  {
    name: 'text-embedding-3-large',
    provider: 'openai',
    dimensions: 3072,
    capabilities: {
      maxBatchSize: 2048,
      configurableDimensions: true,
      normalizesByDefault: true,
      costPer1kTokens: 0.00013,
    },
  },
];

interface EmbeddingResponseBody {
  readonly data?: readonly {
    readonly embedding: readonly number[];
    readonly index: number;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly total_tokens?: number };
}

export class OpenAIEmbeddingProvider extends HttpEmbeddingProvider {
  readonly #apiKey: string | undefined;

  constructor(options: OpenAIEmbeddingOptions) {
    const provider = options.provider ?? 'openai';
    super({
      http: options.http,
      name: provider,
      baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
      models: (options.models ?? DEFAULT_MODELS).map((m) => ({ ...m, provider })),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
      authorization: () =>
        options.apiKey === undefined ? undefined : `Bearer ${options.apiKey}`,
    });
    this.#apiKey = options.apiKey;
  }

  protected buildRequest(batch: EmbeddingBatch): HttpEmbeddingRequest {
    return {
      path: '/embeddings',
      body: {
        model: batch.model,
        input: batch.texts,
        // OpenAI only accepts `dimensions` on the v3 models; sending it to one
        // that ignores it is harmless, and the platform validated it against
        // `supportedDimensions` before we got here.
        dimensions: batch.dimensions,
      },
    };
  }

  protected parseResponse(
    body: unknown,
    batch: EmbeddingBatch,
  ): EmbeddingBatchResponse {
    const data = (body as EmbeddingResponseBody).data;
    if (data === undefined) this.malformed('response had no data array');
    // OpenAI returns items with an `index`; sort by it so ordering never depends
    // on the server preserving request order.
    const ordered = [...data].sort((a, b) => a.index - b.index);
    const usage = (body as EmbeddingResponseBody).usage;
    return {
      model: batch.model,
      dimensions: batch.dimensions,
      embeddings: ordered.map((d) => d.embedding),
      normalized: true,
      ...(usage === undefined
        ? {}
        : {
            usage: {
              ...(usage.prompt_tokens === undefined
                ? {}
                : { promptTokens: usage.prompt_tokens }),
              ...(usage.total_tokens === undefined
                ? {}
                : { totalTokens: usage.total_tokens }),
            },
          }),
    };
  }

  /** Whether an API key was supplied (for a keyless local server, it may be omitted). */
  get hasKey(): boolean {
    return this.#apiKey !== undefined;
  }
}
