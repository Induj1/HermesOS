/**
 * The HTTP vocabulary — a request, a response, a handler, middleware.
 *
 * Deliberately framework-agnostic and plain-data: a request is an object a test
 * can build by hand, a response is an object a test can assert on, and a handler
 * is `(request) => response`. No `req`/`res` streams, no framework's `Context`
 * god-object. The Node adapter (see `node.ts`) translates a real socket into these
 * shapes and back; everything else — routing, middleware, the application — is
 * pure functions over them, so the whole HTTP surface is testable without a
 * server (RFC-0022 §2).
 */

export type HttpMethod =
  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** An incoming request, as plain data. */
export interface HttpRequest {
  readonly method: HttpMethod;
  /** Path only, no query string (e.g. `/missions/42`). */
  readonly path: string;
  /** Parsed query parameters. A repeated key keeps its last value. */
  readonly query: Readonly<Record<string, string>>;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The raw request body, if any. */
  readonly body: string | undefined;
  /** Path parameters captured by the matched route (`:id` → `params.id`). */
  readonly params: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** An outgoing response, as plain data. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/** Per-request context threaded through middleware and to the handler. */
export interface RequestContext {
  /** A per-request id for logging/tracing correlation. */
  readonly requestId: string;
  /** A free-form bag middleware can populate (an authenticated user, a start time). */
  readonly state: Record<string, unknown>;
}

export type Handler = (
  request: HttpRequest,
  context: RequestContext,
) => HttpResponse | Promise<HttpResponse>;

/**
 * Middleware wraps the rest of the pipeline. It may act before (inspect/short-
 * circuit), after (transform the response), or around (timing, error handling) by
 * calling `next`.
 */
export type Middleware = (
  request: HttpRequest,
  context: RequestContext,
  next: () => Promise<HttpResponse>,
) => HttpResponse | Promise<HttpResponse>;
