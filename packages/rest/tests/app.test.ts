/**
 * The application — routing, middleware, and the error boundary — all via
 * `handle(request)`, no socket.
 */

import { describe, expect, it } from 'vitest';
import { Application } from '../src/app.js';
import { HttpError } from '../src/errors.js';
import { json, jsonBody, noContent } from '../src/response.js';
import type { HttpMethod, HttpRequest } from '../src/types.js';

const req = (
  method: HttpMethod,
  path: string,
  over: Partial<HttpRequest> = {},
): HttpRequest => ({
  method,
  path,
  query: {},
  headers: {},
  body: undefined,
  params: {},
  ...over,
});

const parse = (body: string | undefined): unknown => JSON.parse(body ?? 'null');

describe('routing', () => {
  it('dispatches to a handler with path params', async () => {
    const app = new Application().get('/missions/:id', (r) =>
      json(200, { id: r.params['id'] }),
    );
    const res = await app.handle(req('GET', '/missions/7'));
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({ id: '7' });
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns 404 for an unknown path', async () => {
    const app = new Application().get('/a', () => noContent());
    const res = await app.handle(req('GET', '/b'));
    expect(res.status).toBe(404);
    expect((parse(res.body) as { error: { code: string } }).error.code).toBe(
      'not_found',
    );
  });

  it('returns 405 with an Allow header for a known path, wrong method', async () => {
    const app = new Application()
      .get('/a', () => noContent())
      .post('/a', () => noContent());
    const res = await app.handle(req('DELETE', '/a'));
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toContain('GET');
    expect(res.headers['allow']).toContain('POST');
  });

  it('supports all the verb helpers', async () => {
    const app = new Application()
      .get('/x', () => json(200, { v: 'get' }))
      .post('/x', () => json(200, { v: 'post' }))
      .put('/x', () => json(200, { v: 'put' }))
      .patch('/x', () => json(200, { v: 'patch' }))
      .delete('/x', () => json(200, { v: 'delete' }));
    for (const [method, v] of [
      ['GET', 'get'],
      ['POST', 'post'],
      ['PUT', 'put'],
      ['PATCH', 'patch'],
      ['DELETE', 'delete'],
    ] as const) {
      expect(parse((await app.handle(req(method, '/x'))).body)).toEqual({ v });
    }
  });
});

describe('body parsing', () => {
  it('parses a JSON body', async () => {
    const app = new Application().post('/echo', (r) => json(200, jsonBody(r)));
    const res = await app.handle(req('POST', '/echo', { body: '{"a":1}' }));
    expect(parse(res.body)).toEqual({ a: 1 });
  });

  it('turns a missing or malformed body into a 400', async () => {
    const app = new Application().post('/echo', (r) => json(200, jsonBody(r)));
    expect((await app.handle(req('POST', '/echo'))).status).toBe(400);
    expect((await app.handle(req('POST', '/echo', { body: '{bad' }))).status).toBe(400);
  });
});

describe('error boundary', () => {
  it('renders a thrown HttpError as JSON with its status and code', async () => {
    const app = new Application().get('/x', () => {
      throw new HttpError(403, 'nope', { code: 'blocked' });
    });
    const res = await app.handle(req('GET', '/x'));
    expect(res.status).toBe(403);
    expect(parse(res.body)).toEqual({ error: { code: 'blocked', message: 'nope' } });
  });

  it('turns an unexpected throw into a leak-free 500', async () => {
    const app = new Application().get('/x', () => {
      throw new Error('secret internal detail');
    });
    const res = await app.handle(req('GET', '/x'));
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
    expect((parse(res.body) as { error: { code: string } }).error.code).toBe(
      'internal_error',
    );
  });

  it('catches an error thrown from middleware', async () => {
    const app = new Application()
      .use(() => {
        throw new HttpError(401, 'unauthenticated');
      })
      .get('/x', () => noContent());
    expect((await app.handle(req('GET', '/x'))).status).toBe(401);
  });
});

describe('middleware', () => {
  it('runs in registration order and can short-circuit', async () => {
    const order: string[] = [];
    const app = new Application()
      .use(async (_r, _c, next) => {
        order.push('a-before');
        const res = await next();
        order.push('a-after');
        return res;
      })
      .use((_r, _c, next) => {
        order.push('b');
        return next();
      })
      .get('/x', () => {
        order.push('handler');
        return noContent();
      });
    await app.handle(req('GET', '/x'));
    expect(order).toEqual(['a-before', 'b', 'handler', 'a-after']);
  });

  it('a middleware can replace the response without calling the handler', async () => {
    const app = new Application()
      .use(() => json(418, { teapot: true }))
      .get('/x', () => noContent());
    const res = await app.handle(req('GET', '/x'));
    expect(res.status).toBe(418);
  });

  it('shares state and a request id via the context', async () => {
    let seenId: string | undefined;
    const app = new Application({ requestId: () => 'req-fixed' })
      .use((_r, ctx, next) => {
        ctx.state['user'] = 'alice';
        return next();
      })
      .get('/x', (_r, ctx) => {
        seenId = ctx.requestId;
        return json(200, { user: ctx.state['user'] });
      });
    const res = await app.handle(req('GET', '/x'));
    expect(seenId).toBe('req-fixed');
    expect(parse(res.body)).toEqual({ user: 'alice' });
  });

  it('generates incrementing request ids by default', async () => {
    const ids: string[] = [];
    const app = new Application().get('/x', (_r, ctx) => {
      ids.push(ctx.requestId);
      return noContent();
    });
    await app.handle(req('GET', '/x'));
    await app.handle(req('GET', '/x'));
    expect(ids).toEqual(['req-1', 'req-2']);
  });
});
