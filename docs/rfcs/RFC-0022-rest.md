# RFC-0022: REST HTTP Layer

| Field         | Value                            |
| ------------- | -------------------------------- |
| Status        | Implemented                      |
| Date          | 2026-07-18                       |
| Scope         | `packages/rest` (`@hermes/rest`) |
| Depends on    | `@hermes/kernel` (Logger)        |
| Supersedes    | —                                |
| Superseded by | —                                |

Design record for the HTTP layer: a framework-agnostic router, middleware, and a
thin Node adapter.

Covered by 40 tests in `packages/rest/tests`.

---

## 1. Why not Express/Fastify

A framework brings a `req`/`res` stream pair, a `Context` god-object, and a
plugin system — and pulls all of that into every handler and every test. Hermes
needs an HTTP surface for its REST API (#23) and its health/metrics endpoints,
but it does not need a framework's opinions, and it very much wants the surface
to be **testable without a socket**. So the layer is built from plain data.

## 2. The organising principle

> **A request is data, a response is data, and the application is
> `handle(request) → response`.**

`HttpRequest` and `HttpResponse` are plain objects a test constructs and asserts
on. The {@link Application} is a pure-ish function: middleware wrapped around a
{@link Router}, with an error boundary. So an entire API is exercised by calling
`app.handle({ method, path, ... })` — no listening port, no supertest, no
flakiness. The one piece that touches a socket, {@link toNodeListener}, is a
thin translation kept deliberately small and separately covered.

## 3. Routing

Segment-based patterns: a literal matches itself, `:name` captures one segment
(URL-decoded) into `params.name`, and a trailing `*` captures the rest. Routes
are tried in **registration order, first match wins** — so a static route
registered before a `:param` one takes precedence, which is predictable, unlike
a "most specific wins" heuristic that surprises. The router also answers
`pathExists` and `allowedMethods`, so the application distinguishes **404** (no
such path) from **405** (path exists, wrong verb, with an `Allow` header).

## 4. Middleware and the error boundary

Middleware is `(request, context, next) → response` — it may act before, after,
or around by calling `next`, and may short-circuit by not calling it. The chain
is composed outermost-first around the router dispatch. Around all of it is one
error boundary: a thrown {@link HttpError} becomes a JSON
`{ error: { code, message } }` at its status (with any
`Allow`/`WWW-Authenticate` headers it carries); an **unexpected** throw becomes
a `500` whose body is a generic message, because a stack trace or an internal
detail is not a thing to hand a client — it is logged instead, with the request
id.

`RequestContext` carries a per-request id (injectable, an incrementing counter
by default) and a `state` bag middleware populates (an authenticated user, a
start time) — the seam the auth (#26) and observability (#32) layers plug into.

## 5. Response helpers

`json`, `text`, `noContent` build responses with the right `content-type`;
`jsonBody<T>` parses a request body and throws a clean `400` on a missing or
malformed one (rather than an unhandled `SyntaxError` surfacing as a `500`).

## 6. Testing

All via `handle`, no server: routing (literals, params with decoding, wildcard,
length mismatch, order), 404/405, every verb helper, body parsing, the error
boundary (HttpError, leak-free 500, middleware throw), middleware (order,
short-circuit, shared state/id), and the Node adapter against in-memory request
streams and a fake response sink. Branch coverage 98%.

## 7. Non-goals

- **No concrete endpoints.** This is the _layer_; the REST API's mission/health
  routes wire onto it per deployment (they need the runtime, auth, etc.).
- **No TLS / no HTTP2 / no body-size limits at this layer** — the Node server
  (or a reverse proxy) owns those; the adapter reads what it is given.
- **No built-in auth/CORS middleware** — those are their own subsystems (#26–27)
  and compose as middleware.
