/**
 * Response constructors and the error code defaults.
 */

import { describe, expect, it } from 'vitest';
import { json, text, noContent } from '../src/response.js';
import { HttpError } from '../src/errors.js';

describe('response constructors', () => {
  it('json sets a JSON content-type and serializes', () => {
    expect(json(200, { a: 1 })).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"a":1}',
    });
  });

  it('json merges extra headers', () => {
    expect(json(200, {}, { 'x-y': 'z' }).headers['x-y']).toBe('z');
  });

  it('text sets a text content-type', () => {
    expect(text(200, 'hello')).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'hello',
    });
  });

  it('noContent is a 204 with no body', () => {
    expect(noContent()).toEqual({ status: 204, headers: {}, body: undefined });
    expect(noContent({ 'x-y': 'z' }).headers['x-y']).toBe('z');
  });
});

describe('HttpError default codes', () => {
  const cases: readonly [number, string][] = [
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'unprocessable'],
    [429, 'rate_limited'],
    [418, 'error'],
    [500, 'internal_error'],
    [503, 'internal_error'],
  ];
  for (const [status, code] of cases) {
    it(`${String(status)} → ${code}`, () => {
      expect(new HttpError(status, 'x').code).toBe(code);
    });
  }

  it('accepts an explicit code and headers', () => {
    const err = new HttpError(401, 'nope', {
      code: 'token_expired',
      headers: { 'www-authenticate': 'Bearer' },
    });
    expect(err.code).toBe('token_expired');
    expect(err.headers['www-authenticate']).toBe('Bearer');
  });
});
