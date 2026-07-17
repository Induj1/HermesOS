/**
 * FetchHttpClient and the toolset against a real HTTP server.
 *
 * A local `node:http` server, so these run anywhere with no network and no
 * external dependency, while still exercising the real `fetch` path: real
 * streaming (for the size cap), a real timeout, a real redirect, and the toolset
 * dispatched through an actual kernel `Runtime`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { catalog, PermissionSet } from '@hermes/tools';
import { FetchHttpClient } from '../src/fetch-client.js';
import { httpToolset } from '../src/toolset.js';

let server: Server;
let base: string;
let runtime: Runtime | undefined;

/** Routes the tests need, on one small server. */
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/hello') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
    } else if (url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (url === '/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        res.writeHead(201);
        res.end(body);
      });
    } else if (url === '/big') {
      res.writeHead(200);
      // Stream far more than the test cap, one chunk at a time.
      let sent = 0;
      const chunk = 'x'.repeat(10_000);
      const pump = (): void => {
        if (sent > 500_000) return void res.end();
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    } else if (url === '/slow') {
      setTimeout(() => res.end('late'), 10_000).unref();
    } else if (url === '/redirect') {
      res.writeHead(302, { location: '/hello' });
      res.end();
    } else if (url === '/notfound') {
      res.writeHead(404);
      res.end('nope');
    } else {
      res.writeHead(500);
      res.end('unhandled');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

afterEach(async () => {
  await runtime?.stop({ mode: 'cancel' });
  runtime = undefined;
});

// The client must reach 127.0.0.1 for these tests, so blockPrivate is off.
const client = new FetchHttpClient();

describe('FetchHttpClient', () => {
  it('fetches a real body and headers', async () => {
    const response = await client.request({ url: `${base}/hello` });

    expect(response.status).toBe(200);
    expect(response.body).toBe('hello world');
    expect(response.headers['content-type']).toBe('text/plain');
  });

  it('posts a body and reads it back', async () => {
    const response = await client.request({
      url: `${base}/echo`,
      method: 'POST',
      body: 'payload',
    });

    expect(response.status).toBe(201);
    expect(response.body).toBe('payload');
  });

  it('returns a 404 as a response, not an error', async () => {
    const response = await client.request({ url: `${base}/notfound` });

    expect(response.status).toBe(404);
    expect(response.body).toBe('nope');
  });

  it('does not follow a redirect itself', async () => {
    const response = await client.request({ url: `${base}/redirect` });

    // 302 returned raw, with the location header — the guard follows, not this.
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/hello');
  });

  // The streaming cap on a real, large, chunked response.
  it('caps an oversized body mid-stream', async () => {
    const response = await client.request({ url: `${base}/big`, maxBytes: 50_000 });

    expect(response.truncated).toBe(true);
    // Bounded near the cap, not the full half-megabyte the server tried to send.
    expect(response.body.length).toBeLessThanOrEqual(50_000);
  });

  it('times out a slow response', async () => {
    await expect(
      client.request({ url: `${base}/slow`, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('honours a caller abort', async () => {
    await expect(
      client.request({ url: `${base}/slow`, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it('surfaces a connection failure as NETWORK_ERROR', async () => {
    // Nothing listening on this port.
    await expect(
      client.request({ url: 'http://127.0.0.1:1/x', timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('uses an injected fetch', async () => {
    const fake: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('injected', { status: 200 }));
    const custom = new FetchHttpClient({ fetch: fake });

    expect((await custom.request({ url: 'https://anywhere.test/' })).body).toBe(
      'injected',
    );
  });

  it('handles a response with a null body', async () => {
    const fake: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 204 }));
    const custom = new FetchHttpClient({ fetch: fake });

    const response = await custom.request({ url: 'https://anywhere.test/' });

    expect(response.status).toBe(204);
    expect(response.body).toBe('');
  });

  it('surfaces a body stream that errors mid-read as NETWORK_ERROR', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('connection reset'));
      },
    });
    const fake: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(stream, { status: 200 }));
    const custom = new FetchHttpClient({ fetch: fake });

    await expect(
      custom.request({ url: 'https://anywhere.test/' }),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});

describe('httpToolset on a real runtime', () => {
  it('registers the tools and fetches through a dispatched mission', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      httpToolset({
        client,
        policy: { blockPrivate: false },
        granted: PermissionSet.none().grant('net:read'),
      }),
    );
    await runtime.start();

    expect(catalog(runtime.tools).map((t) => t.name)).toContain('http.get');

    const snapshot = await runtime.run({
      name: 'fetch',
      tasks: [
        {
          name: 'f',
          handler: { kind: 'tool', name: 'http.get' },
          input: { url: `${base}/json` },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
  });

  it('follows a real redirect and re-checks it', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      httpToolset({
        client,
        policy: { blockPrivate: false },
        granted: PermissionSet.none().grant('net:read'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'redirect',
      tasks: [
        {
          name: 'r',
          handler: { kind: 'tool', name: 'http.get' },
          input: { url: `${base}/redirect` },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toMatchObject({
      status: 200,
      body: 'hello world',
    });
  });

  it('refuses http.request when only net:read was granted', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      httpToolset({
        client,
        policy: { blockPrivate: false },
        granted: PermissionSet.none().grant('net:read'),
      }),
    );
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'post',
      tasks: [
        {
          name: 'p',
          handler: { kind: 'tool', name: 'http.request' },
          input: { url: `${base}/echo`, method: 'POST', body: 'x' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "net:write" permission/,
    );
  });
});
