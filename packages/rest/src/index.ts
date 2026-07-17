/**
 * @hermes/rest — a framework-agnostic HTTP layer.
 *
 * A request is plain data, a response is plain data, and an {@link Application} is
 * `handle(request) → response` — middleware wrapped around a {@link Router}, with
 * an error boundary that turns a thrown {@link HttpError} into JSON and an
 * unexpected throw into a leak-free `500`. Because it is a pure function of a
 * request object, an entire API is tested by calling `handle` with plain objects;
 * the {@link toNodeListener} adapter is the only piece that touches a socket, and
 * it is kept thin.
 *
 * ```ts
 * import { Application, json, jsonBody, HttpError, toNodeListener } from '@hermes/rest';
 * import { createServer } from 'node:http';
 *
 * const app = new Application()
 *   .use(async (req, ctx, next) => { ctx.state['t'] = Date.now(); return next(); })
 *   .get('/missions/:id', (req) => json(200, { id: req.params.id }))
 *   .post('/missions', (req) => json(201, jsonBody(req)));
 *
 * createServer(toNodeListener(app)).listen(3000);
 * // or, in a test: await app.handle({ method: 'GET', path: '/missions/42', query: {}, headers: {}, body: undefined, params: {} })
 * ```
 *
 * See `docs/rfcs/RFC-0022-rest.md` for the design.
 */

export { Application } from './app.js';
export type { ApplicationOptions } from './app.js';

export { Router } from './router.js';
export type { RouteMatch } from './router.js';

export { HttpError } from './errors.js';

export { json, text, noContent, jsonBody } from './response.js';

export { toNodeListener, toHttpRequest } from './node.js';
export type { NodeRequest, NodeResponse } from './node.js';

export type {
  HttpMethod,
  HttpRequest,
  HttpResponse,
  Handler,
  Middleware,
  RequestContext,
} from './types.js';
