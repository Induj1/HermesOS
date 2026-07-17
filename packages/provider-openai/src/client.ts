/**
 * The OpenAI HTTP client — a thin wrapper over the shared provider plumbing.
 *
 * The transport, JSON handling, and status → `ModelError` mapping are all
 * `@hermes/provider-http`'s (shared with every other provider so classification
 * is uniform). This adds only what is OpenAI's: the `Authorization: Bearer`
 * header, an optional org/Azure header set, and the one status override that is
 * vendor-specific — `context_length_exceeded` → `ContextTooLong`.
 *
 * Compatible with any OpenAI-shaped API (Azure OpenAI, Ollama's `/v1`, vLLM); the
 * base URL and key are the only difference.
 */

import type { HttpClient } from '@hermes/tools-http';
import { ContextTooLongError } from '@hermes/model';
import {
  postJson,
  statusClassifier,
  codeOf,
  type ClassifyFn,
} from '@hermes/provider-http';

export interface OpenAIClientOptions {
  readonly http: HttpClient;
  /** API key. Sent as `Authorization: Bearer …`. Optional for keyless local servers. */
  readonly apiKey?: string;
  /** API base. Default `https://api.openai.com/v1`. Point it at Azure/Ollama/etc. */
  readonly baseUrl?: string;
  /** Provider name used in errors and `ModelInfo`. Default `openai`. */
  readonly provider?: string;
  readonly userAgent?: string;
  /** Extra headers (e.g. an Azure `api-key`, an org id). */
  readonly headers?: Readonly<Record<string, string>>;
}

export class OpenAIClient {
  readonly provider: string;
  readonly #http: HttpClient;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #classify: ClassifyFn;

  constructor(options: OpenAIClientOptions) {
    this.#http = options.http;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
    this.provider = options.provider ?? 'openai';
    this.#userAgent = options.userAgent ?? 'hermes';
    this.#headers = options.headers ?? {};
    this.#classify = statusClassifier(this.provider, {
      override: (status, _headers, body) =>
        (status === 400 || status === 422) && codeOf(body) === 'context_length_exceeded'
          ? new ContextTooLongError(this.provider)
          : undefined,
    });
  }

  /** POST a JSON body to a path and return the parsed JSON, or throw a ModelError. */
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      'user-agent': this.#userAgent,
      ...this.#headers,
    };
    if (this.#apiKey !== undefined) headers['authorization'] = `Bearer ${this.#apiKey}`;
    return postJson<T>({
      http: this.#http,
      url: `${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
      headers,
      body,
      provider: this.provider,
      classify: this.#classify,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export { safeJson } from '@hermes/provider-http';
