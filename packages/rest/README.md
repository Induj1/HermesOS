# @hermes/rest

A framework-agnostic HTTP layer — router, middleware, and a thin Node adapter,
testable without a socket.

- **Design record:** [RFC-0022](../../docs/rfcs/RFC-0022-rest.md).
- **Depends on:** `@hermes/kernel` (Logger).

## The idea

A request is plain data, a response is plain data, and an `Application` is
`handle(request) → response` — middleware wrapped around a router, with an error
boundary. An entire API is tested by calling `handle` with plain objects; the
`toNodeListener` adapter is the only piece that touches a socket.

## Usage

```ts
import {
  Application,
  json,
  jsonBody,
  HttpError,
  toNodeListener,
} from '@hermes/rest';
import { createServer } from 'node:http';

const app = new Application()
  .use(async (req, ctx, next) => {
    ctx.state['start'] = Date.now(); // middleware: before / after / around
    return next();
  })
  .get('/missions/:id', (req) => json(200, { id: req.params['id'] }))
  .post('/missions', (req) => json(201, jsonBody(req)))
  .delete('/missions/:id', (req) => {
    if (!exists(req.params['id']))
      throw new HttpError(404, 'mission not found');
    return noContent();
  });

createServer(toNodeListener(app)).listen(3000);
```

Testing needs no server:

```ts
const res = await app.handle({
  method: 'GET',
  path: '/missions/42',
  query: {},
  headers: {},
  body: undefined,
  params: {},
});
expect(res.status).toBe(200);
```

## Behaviour

- **Routing** — literals, `:param` (URL-decoded), trailing `*` wildcard; first
  registered match wins. **404** vs **405** (with `Allow`) distinguished.
- **Error boundary** — a thrown `HttpError` → JSON at its status; an unexpected
  throw → a leak-free `500` (logged with the request id).
- **`RequestContext`** — a per-request id and a `state` bag for middleware
  (auth, timing).
- **Helpers** — `json` / `text` / `noContent`; `jsonBody<T>` with a clean `400`.

## Non-goals

Concrete endpoints, TLS, and auth/CORS are elsewhere — this is the layer they
compose onto (RFC-0022 §7).
