/**
 * The Anthropic HTTP client — a thin wrapper over the shared provider plumbing.
 *
 * Transport, JSON, and the standard status → `ModelError` mapping are
 * `@hermes/provider-http`'s. Anthropic's differences are small and local: the
 * `x-api-key` and `anthropic-version` headers, and a status override that reads a
 * too-long-prompt message as `ContextTooLong`. Its `529` "overloaded" needs no
 * special case — the shared classifier already treats every `5xx` as a retryable
 * `ModelUnavailable`.
 */

import type { HttpClient } from '@hermes/tools-http';
import { ContextTooLongError } from '@hermes/model';
import { postJson, statusClassifier, type ClassifyFn } from '@hermes/provider-http';

/** The Anthropic Messages API version pinned in the header. */
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicClientOptions {
  readonly http: HttpClient;
  readonly apiKey?: string;
  /** API base. Default `https://api.anthropic.com/v1`. */
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly userAgent?: string;
  /** Pinned API version. Default `2023-06-01`. */
  readonly version?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class AnthropicClient {
  readonly provider: string;
  readonly #http: HttpClient;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #version: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #classify: ClassifyFn;

  constructor(options: AnthropicClientOptions) {
    this.#http = options.http;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(
      /\/+$/,
      '',
    );
    this.provider = options.provider ?? 'anthropic';
    this.#userAgent = options.userAgent ?? 'hermes';
    this.#version = options.version ?? ANTHROPIC_VERSION;
    this.#headers = options.headers ?? {};
    this.#classify = statusClassifier(this.provider, {
      override: (status, _headers, _body, message) =>
        (status === 400 || status === 422) &&
        message !== undefined &&
        /prompt is too long|maximum.*tokens|context/i.test(message)
          ? new ContextTooLongError(this.provider)
          : undefined,
    });
  }

  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      'user-agent': this.#userAgent,
      'anthropic-version': this.#version,
      ...this.#headers,
    };
    if (this.#apiKey !== undefined) headers['x-api-key'] = this.#apiKey;
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
