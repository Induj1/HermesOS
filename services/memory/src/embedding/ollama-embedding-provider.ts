/**
 * Embeddings from a local Ollama server.
 *
 * The production provider for HermesOS as configured today: `.env` ships
 * `OLLAMA_MODELS=llama3.2,nomic-embed-text` and `OLLAMA_URL=http://127.0.0.1:11434`,
 * and `nomic-embed-text` is a 768-wide model — the width migration 0004's
 * `vector(768)` column is cut for.
 *
 * Talks to `/api/embed` (the batch endpoint) with `fetch`, so there is no SDK
 * dependency. Everything it needs is injected: no `process.env` is read here, in
 * keeping with the kernel's rule that configuration is injected, never
 * discovered (RFC-0001 §3).
 */

import {
  assertValidEmbedding,
  type Embedding,
  type EmbeddingProvider,
} from './provider.js';
import { EmbeddingFailedError, toError } from '../errors.js';

export interface OllamaEmbeddingOptions {
  /** Base URL, e.g. `http://127.0.0.1:11434`. From OLLAMA_URL. */
  readonly baseUrl: string;
  /** Defaults to `nomic-embed-text`, the embedding model in OLLAMA_MODELS. */
  readonly model?: string;
  /**
   * Vector width. Defaults to 768, which is nomic-embed-text's.
   *
   * Declared rather than discovered because a provider's `dimensions` must be
   * known synchronously, at construction — the alternative is an async getter
   * that every caller has to await before it can size anything. It is verified
   * against reality on the first response by {@link assertValidEmbedding}, so a
   * wrong value here fails loudly and immediately rather than writing
   * wrong-width vectors.
   */
  readonly dimensions?: number;
  /** Abort a request that hangs. Defaults to 30s. */
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

interface OllamaEmbedResponse {
  readonly embeddings?: readonly (readonly number[])[];
  readonly error?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OllamaEmbeddingOptions) {
    this.model = options.model ?? 'nomic-embed-text';
    this.dimensions = options.dimensions ?? 768;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly Embedding[]> {
    // Ollama answers an empty batch with an error. Returning early also spares
    // the caller from special-casing "nothing to embed" at every call site.
    if (texts.length === 0) return [];

    const response = await this.#post(texts, signal);
    const vectors = response.embeddings;

    if (!vectors) {
      throw new EmbeddingFailedError(
        this.model,
        response.error ?? 'response contained no embeddings',
      );
    }
    // A short batch would otherwise pair vector[i] with text[i+1] onwards —
    // every subsequent memory silently embedded as its neighbour. Nothing
    // downstream can detect that, so it has to be caught here.
    if (vectors.length !== texts.length) {
      throw new EmbeddingFailedError(
        this.model,
        `expected ${String(texts.length)} vectors, got ${String(vectors.length)}`,
      );
    }

    vectors.forEach((vector, index) => {
      assertValidEmbedding(this, vector, index);
    });
    return vectors;
  }

  async #post(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<OllamaEmbedResponse> {
    // Two independent reasons to give up — our timeout and the caller's
    // cancellation — combined into the one signal fetch accepts. `AbortSignal.any`
    // also releases its listeners when the first fires, so a long-lived caller
    // signal does not accumulate one listener per request.
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: combined,
      });
    } catch (thrown) {
      const error = toError(thrown);
      // "TimeoutError: The operation was aborted due to timeout" tells you
      // nothing about what to fix. Naming the URL and the likely cause does:
      // this is the error someone sees when Ollama simply is not running.
      const reason = timeout.aborted
        ? `no response within ${String(this.#timeoutMs)}ms`
        : error.message;
      throw new EmbeddingFailedError(
        this.model,
        `request to ${this.#baseUrl}/api/embed failed (${reason}). ` +
          `Is Ollama running, and has "${this.model}" been pulled?`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EmbeddingFailedError(
        this.model,
        `${this.#baseUrl}/api/embed returned ${String(response.status)}` +
          (body ? `: ${body.slice(0, 200)}` : ''),
      );
    }

    try {
      return (await response.json()) as OllamaEmbedResponse;
    } catch (thrown) {
      throw new EmbeddingFailedError(this.model, 'response was not valid JSON', {
        cause: toError(thrown),
      });
    }
  }
}
