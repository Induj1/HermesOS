/**
 * The Gemini HTTP client — a thin wrapper over the shared provider plumbing.
 *
 * Transport, JSON, and the standard status → `ModelError` mapping are
 * `@hermes/provider-http`'s. Google's differences are the `x-goog-api-key` header
 * (the key goes in a header, not the URL, so it never lands in a log line) and a
 * status override reading a token-limit message as `ContextTooLong`.
 */

import type { HttpClient } from '@hermes/tools-http';
import { ContextTooLongError } from '@hermes/model';
import { postJson, statusClassifier, type ClassifyFn } from '@hermes/provider-http';

export interface GoogleClientOptions {
  readonly http: HttpClient;
  readonly apiKey?: string;
  /** API base. Default `https://generativelanguage.googleapis.com/v1beta`. */
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly userAgent?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class GoogleClient {
  readonly provider: string;
  readonly #http: HttpClient;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #classify: ClassifyFn;

  constructor(options: GoogleClientOptions) {
    this.#http = options.http;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (
      options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
    this.provider = options.provider ?? 'google';
    this.#userAgent = options.userAgent ?? 'hermes';
    this.#headers = options.headers ?? {};
    this.#classify = statusClassifier(this.provider, {
      override: (status, _headers, _body, message) =>
        (status === 400 || status === 422) &&
        message !== undefined &&
        /token count|exceeds the maximum|context length/i.test(message)
          ? new ContextTooLongError(this.provider)
          : undefined,
    });
  }

  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      'user-agent': this.#userAgent,
      ...this.#headers,
    };
    if (this.#apiKey !== undefined) headers['x-goog-api-key'] = this.#apiKey;
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
