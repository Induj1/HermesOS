/**
 * The shared provider HTTP plumbing: POST, transport mapping, and the standard
 * status classifier.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient, HttpError } from '@hermes/tools-http';
import {
  postJson,
  statusClassifier,
  retryAfterMs,
  messageOf,
  codeOf,
  errorObject,
  safeJson,
} from '../src/http.js';

const classify = statusClassifier('test');

const post = (
  handle: ConstructorParameters<typeof FakeHttpClient>[0]['handle'],
  signal?: AbortSignal,
): Promise<unknown> =>
  postJson({
    http: new FakeHttpClient({ handle }),
    url: 'https://api.test/x',
    headers: { authorization: 'Bearer k' },
    body: { a: 1 },
    provider: 'test',
    classify,
    ...(signal === undefined ? {} : { signal }),
  });

describe('postJson', () => {
  it('sends JSON with a content-type and returns the parsed body', async () => {
    const http = new FakeHttpClient({
      handle: () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }),
    });
    const result = await postJson<{ ok: boolean }>({
      http,
      url: 'https://api.test/x',
      headers: { authorization: 'Bearer k' },
      body: { a: 1 },
      provider: 'test',
      classify,
    });
    expect(result.ok).toBe(true);
    const req = http.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.headers?.['content-type']).toBe('application/json');
    expect(req?.headers?.['authorization']).toBe('Bearer k');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ a: 1 });
  });

  it('maps a transport TIMEOUT to MODEL_TIMEOUT and other faults to MODEL_UNAVAILABLE', async () => {
    await expect(
      post(() => {
        throw new HttpError('TIMEOUT', 'u', 'x');
      }),
    ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });
    await expect(
      post(() => {
        throw new HttpError('NETWORK_ERROR', 'u', 'x');
      }),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
  });

  it('rethrows a non-HttpError unchanged', async () => {
    await expect(
      post(() => {
        throw new Error('bug');
      }),
    ).rejects.toThrow('bug');
  });

  it('classifies a non-2xx status', async () => {
    await expect(post(() => ({ status: 401, body: '{}' }))).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('forwards an abort signal', async () => {
    await expect(
      post(() => ({ status: 200, body: '{}' }), AbortSignal.abort()),
    ).rejects.toThrow();
  });
});

describe('statusClassifier', () => {
  const cases: readonly [number, string, boolean][] = [
    [401, 'AUTHENTICATION_FAILED', false],
    [403, 'AUTHENTICATION_FAILED', false],
    [404, 'MODEL_UNAVAILABLE', true],
    [429, 'RATE_LIMITED', true],
    [400, 'INVALID_REQUEST', false],
    [422, 'INVALID_REQUEST', false],
    [500, 'MODEL_UNAVAILABLE', true],
    [529, 'MODEL_UNAVAILABLE', true],
    [418, 'MODEL_ERROR', false],
  ];
  for (const [status, code, retryable] of cases) {
    it(`${String(status)} → ${code}`, () => {
      expect(classify(status, {}, {})).toMatchObject({ code, retryable });
    });
  }

  it('reads retry-after into a rate limit', () => {
    expect(
      (classify(429, { 'retry-after': '7' }, {}) as { retryAfterMs?: number })
        .retryAfterMs,
    ).toBe(7000);
  });

  it('surfaces the error message', () => {
    expect(classify(400, {}, { error: { message: 'nope' } }).message).toContain('nope');
  });

  it('lets an override pre-empt the default mapping', () => {
    const withOverride = statusClassifier('test', {
      override: (status, _h, _b, message) =>
        status === 400 && message === 'too long'
          ? (new Error('CTX') as never)
          : undefined,
    });
    expect(withOverride(400, {}, { error: { message: 'too long' } }).message).toBe(
      'CTX',
    );
    // Falls through to the default for other 400s.
    expect(withOverride(400, {}, { error: { message: 'other' } }).code).toBe(
      'INVALID_REQUEST',
    );
  });
});

describe('helpers', () => {
  it('retryAfterMs reads whole seconds only', () => {
    expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfterMs({ 'retry-after': 'soon' })).toBeUndefined();
    expect(retryAfterMs({})).toBeUndefined();
  });

  it('messageOf reads the three shapes', () => {
    expect(messageOf({ error: 'flat' })).toBe('flat');
    expect(messageOf({ error: { message: 'nested' } })).toBe('nested');
    expect(messageOf({ message: 'top' })).toBe('top');
    expect(messageOf({ other: 1 })).toBeUndefined();
    expect(messageOf('string')).toBeUndefined();
  });

  it('codeOf reads error.code', () => {
    expect(codeOf({ error: { code: 'context_length_exceeded' } })).toBe(
      'context_length_exceeded',
    );
    expect(codeOf({ error: {} })).toBeUndefined();
    expect(codeOf({})).toBeUndefined();
  });

  it('errorObject returns the error object or undefined', () => {
    expect(errorObject({ error: { a: 1 } })).toEqual({ a: 1 });
    expect(errorObject({ error: 'flat' })).toBeUndefined();
    expect(errorObject({})).toBeUndefined();
  });

  it('safeJson parses, passes through, and empties', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('nope')).toBe('nope');
    expect(safeJson('')).toBeUndefined();
  });
});
