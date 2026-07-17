/**
 * The Node adapter — translating a request stream and writing the response,
 * against in-memory fakes (no real server).
 */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { Application } from '../src/app.js';
import { json } from '../src/response.js';
import {
  toHttpRequest,
  toNodeListener,
  type NodeRequest,
  type NodeResponse,
} from '../src/node.js';

/** A fake Node request stream from a method, url, headers, and body chunks. */
const nodeReq = (
  over: Partial<{
    method: string;
    url: string;
    headers: Record<string, string | string[]>;
    chunks: (string | Uint8Array)[];
  }> = {},
): NodeRequest => {
  const stream = Readable.from(over.chunks ?? []) as unknown as NodeRequest;
  return Object.assign(stream, {
    method: over.method ?? 'GET',
    url: over.url ?? '/',
    headers: over.headers ?? {},
  });
};

/** A fake Node response sink capturing the write. */
const nodeRes = (): NodeResponse & {
  status?: number;
  sentHeaders?: Record<string, string>;
  ended?: string;
} => {
  const res: NodeResponse & {
    status?: number;
    sentHeaders?: Record<string, string>;
    ended?: string;
  } = {
    writeHead(status, headers) {
      res.status = status;
      res.sentHeaders = headers;
      return res;
    },
    end(body) {
      res.ended = body;
      return res;
    },
  };
  return res;
};

describe('toHttpRequest', () => {
  it('parses method, path, query, headers, and body', async () => {
    const request = await toHttpRequest(
      nodeReq({
        method: 'post',
        url: '/missions?state=open&limit=5',
        headers: { 'Content-Type': 'application/json', 'x-multi': ['a', 'b'] },
        chunks: ['{"a":', '1}'],
      }),
    );
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/missions');
    expect(request.query).toEqual({ state: 'open', limit: '5' });
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-multi']).toBe('a, b');
    expect(request.body).toBe('{"a":1}');
  });

  it('decodes binary chunks and reports an empty body as undefined', async () => {
    const withBytes = await toHttpRequest(
      nodeReq({ chunks: [new TextEncoder().encode('hi')] }),
    );
    expect(withBytes.body).toBe('hi');
    const empty = await toHttpRequest(nodeReq({}));
    expect(empty.body).toBeUndefined();
  });

  it('defaults method and url', async () => {
    const request = await toHttpRequest(
      Object.assign(Readable.from([]) as unknown as NodeRequest, { headers: {} }),
    );
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/');
  });
});

describe('toNodeListener', () => {
  it('dispatches through the application and writes the response', async () => {
    const app = new Application().get('/hi', () =>
      json(201, { ok: true }, { 'x-custom': 'y' }),
    );
    const listener = toNodeListener(app);
    const res = nodeRes();
    listener(nodeReq({ url: '/hi' }), res);
    // The listener runs async; wait a tick for it to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status).toBe(201);
    expect(res.sentHeaders?.['x-custom']).toBe('y');
    expect(JSON.parse(res.ended ?? '{}')).toEqual({ ok: true });
  });

  it('writes an empty string for a body-less response', async () => {
    const app = new Application().get('/none', () => ({
      status: 204,
      headers: {},
      body: undefined,
    }));
    const res = nodeRes();
    toNodeListener(app)(nodeReq({ url: '/none' }), res);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.ended).toBe('');
  });
});
