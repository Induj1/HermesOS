/**
 * A scripted HTTP client — the default for tests, and a real implementation.
 *
 * Makes no network request. It answers from a handler a test provides, so the
 * tools and the guard can be exercised deterministically — no live server, no
 * flakiness, and, crucially, the ability to script a **redirect to a blocked
 * host**, which is the security case that matters most and cannot be provoked
 * against a real server on demand.
 *
 * It is also useful beyond tests: a host that wants to expose a fixed set of
 * canned responses to an agent (a mock API, a replay of recorded fixtures) backs
 * the tools with one of these.
 */

import type { HttpClient, HttpRequest, HttpResponse } from './client.js';

export type FakeResponse = Partial<Omit<HttpResponse, 'redirects'>>;

export type FakeHandler = (req: HttpRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeHttpClientOptions {
  readonly handle: FakeHandler;
}

export class FakeHttpClient implements HttpClient {
  /** Every request it received, in order, for a test to assert on. */
  readonly requests: HttpRequest[] = [];
  readonly #handle: FakeHandler;

  constructor(options: FakeHttpClientOptions) {
    this.#handle = options.handle;
  }

  /** A fixed 200 with the given body — the simplest useful fake. */
  static respondingWith(body: string, status = 200): FakeHttpClient {
    return new FakeHttpClient({ handle: () => ({ body, status }) });
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    req.signal?.throwIfAborted();

    const partial = await this.#handle(req);
    return {
      status: partial.status ?? 200,
      statusText: partial.statusText ?? '',
      headers: partial.headers ?? {},
      body: partial.body ?? '',
      url: partial.url ?? req.url,
      truncated: partial.truncated ?? false,
      redirects: 0,
    };
  }
}
