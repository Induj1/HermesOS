/**
 * The router — path matching, parameters, and 404-vs-405 support.
 */

import { describe, expect, it } from 'vitest';
import { Router } from '../src/router.js';
import { json } from '../src/response.js';

const h = () => json(200, {});

describe('Router.match', () => {
  it('matches a literal path and method', () => {
    const r = new Router().add('GET', '/health', h);
    expect(r.match('GET', '/health')).toBeDefined();
    expect(r.match('POST', '/health')).toBeUndefined();
    expect(r.match('GET', '/other')).toBeUndefined();
  });

  it('captures path parameters, decoding them', () => {
    const r = new Router().add('GET', '/missions/:id/tasks/:task', h);
    const m = r.match('GET', '/missions/42/tasks/a%20b');
    expect(m?.params).toEqual({ id: '42', task: 'a b' });
  });

  it('captures a trailing wildcard', () => {
    const r = new Router().add('GET', '/files/*', h);
    expect(r.match('GET', '/files/a/b/c.txt')?.params).toEqual({ '*': 'a/b/c.txt' });
  });

  it('does not match when lengths differ', () => {
    const r = new Router().add('GET', '/a/:b', h);
    expect(r.match('GET', '/a')).toBeUndefined();
    expect(r.match('GET', '/a/b/c')).toBeUndefined();
  });

  it('ignores leading/trailing slashes', () => {
    const r = new Router().add('GET', '/a/b', h);
    expect(r.match('GET', '/a/b/')).toBeDefined();
  });

  it('tries routes in registration order, first match wins', () => {
    const first = () => json(200, { which: 'static' });
    const second = () => json(200, { which: 'param' });
    const r = new Router()
      .add('GET', '/x/static', first)
      .add('GET', '/x/:name', second);
    expect(r.match('GET', '/x/static')?.handler).toBe(first);
    expect(r.match('GET', '/x/other')?.handler).toBe(second);
  });
});

describe('pathExists / allowedMethods', () => {
  it('reports a path existing under any method', () => {
    const r = new Router().add('POST', '/missions', h).add('GET', '/missions', h);
    expect(r.pathExists('/missions')).toBe(true);
    expect(r.pathExists('/nope')).toBe(false);
    expect([...r.allowedMethods('/missions')].sort()).toEqual(['GET', 'POST']);
    expect(r.allowedMethods('/nope')).toEqual([]);
  });
});
