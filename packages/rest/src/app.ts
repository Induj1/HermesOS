/**
 * The application — middleware pipeline, routing, and the error boundary.
 *
 * `handle(request)` is the whole HTTP server as a pure-ish function: build a
 * per-request context, run the request through the middleware chain wrapped around
 * the router dispatch, and turn any thrown {@link HttpError} into a JSON response
 * (an *unexpected* throw into a `500` that does not leak its message). Because it
 * is just `request → response`, an entire API is tested by calling `handle` with
 * plain request objects — no socket, no Node adapter.
 */

import { noopLogger, type Logger } from '@hermes/kernel';
import { HttpError } from './errors.js';
import { Router } from './router.js';
import { json } from './response.js';
import type {
  Handler,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  Middleware,
  RequestContext,
} from './types.js';

export interface ApplicationOptions {
  readonly logger?: Logger;
  /** Per-request id generator (for logging/tracing). Default an incrementing counter. */
  readonly requestId?: () => string;
}

export class Application {
  readonly #router = new Router();
  readonly #middleware: Middleware[] = [];
  readonly #logger: Logger;
  readonly #requestId: () => string;
  #seq = 0;

  constructor(options: ApplicationOptions = {}) {
    this.#logger = (options.logger ?? noopLogger).child({ component: 'rest' });
    this.#requestId = options.requestId ?? (() => `req-${String((this.#seq += 1))}`);
  }

  /** Add middleware. Middleware runs in registration order, outermost first. */
  use(middleware: Middleware): this {
    this.#middleware.push(middleware);
    return this;
  }

  route(method: HttpMethod, pattern: string, handler: Handler): this {
    this.#router.add(method, pattern, handler);
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.route('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.route('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler): this {
    return this.route('PUT', pattern, handler);
  }
  patch(pattern: string, handler: Handler): this {
    return this.route('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.route('DELETE', pattern, handler);
  }

  /** Handle one request end to end, returning the response. Never throws. */
  async handle(request: HttpRequest): Promise<HttpResponse> {
    const context: RequestContext = { requestId: this.#requestId(), state: {} };
    const dispatch = (): Promise<HttpResponse> => this.#dispatch(request, context);
    const chain = this.#middleware.reduceRight<() => Promise<HttpResponse>>(
      (next, middleware) => () => Promise.resolve(middleware(request, context, next)),
      dispatch,
    );
    try {
      return await chain();
    } catch (err) {
      return this.#onError(err, context);
    }
  }

  async #dispatch(
    request: HttpRequest,
    context: RequestContext,
  ): Promise<HttpResponse> {
    const match = this.#router.match(request.method, request.path);
    if (match === undefined) {
      if (this.#router.pathExists(request.path)) {
        const allow = this.#router.allowedMethods(request.path).join(', ');
        throw new HttpError(
          405,
          `method ${request.method} not allowed for ${request.path}`,
          {
            headers: { allow },
          },
        );
      }
      throw new HttpError(404, `no route for ${request.method} ${request.path}`);
    }
    const withParams: HttpRequest = { ...request, params: match.params };
    return match.handler(withParams, context);
  }

  #onError(err: unknown, context: RequestContext): HttpResponse {
    if (err instanceof HttpError) {
      this.#logger.debug('request failed', {
        requestId: context.requestId,
        status: err.status,
        code: err.code,
      });
      return json(
        err.status,
        { error: { code: err.code, message: err.message } },
        err.headers,
      );
    }
    // An unexpected throw is a bug: log it, but never hand the client a stack.
    this.#logger.error('unhandled error handling request', {
      requestId: context.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, {
      error: { code: 'internal_error', message: 'internal server error' },
    });
  }
}
