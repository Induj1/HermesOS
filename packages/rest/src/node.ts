/**
 * The Node adapter — the one piece that touches a real socket.
 *
 * It translates a Node `IncomingMessage` into an {@link HttpRequest}, hands it to
 * the {@link Application}, and writes the {@link HttpResponse} back. Everything
 * interesting is in the application (which is pure and tested without this); the
 * adapter is deliberately thin, so the untested-against-a-real-server surface is
 * as small as possible.
 */

import type { IncomingMessage } from 'node:http';
import type { Application } from './app.js';
import type { HttpMethod, HttpRequest } from './types.js';

/** A minimal request stream — an `IncomingMessage` or any async-iterable of chunks. */
export type NodeRequest = Pick<IncomingMessage, 'method' | 'url' | 'headers'> &
  AsyncIterable<Uint8Array | string>;

/** A minimal response sink — a `ServerResponse` or a test double with the same two methods. */
export interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
}

/**
 * Build a Node request listener that dispatches through the application.
 *
 * ```ts
 * import { createServer } from 'node:http';
 * createServer(toNodeListener(app)).listen(3000);
 * ```
 */
export function toNodeListener(
  app: Application,
): (req: NodeRequest, res: NodeResponse) => void {
  return (req, res) => {
    void dispatch(app, req, res);
  };
}

async function dispatch(
  app: Application,
  req: NodeRequest,
  res: NodeResponse,
): Promise<void> {
  const request = await toHttpRequest(req);
  const response = await app.handle(request);
  res.writeHead(response.status, { ...response.headers });
  res.end(response.body ?? '');
}

/** Read a Node request into an {@link HttpRequest}. Exported for the adapter's tests. */
export async function toHttpRequest(req: NodeRequest): Promise<HttpRequest> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = await readBody(req);
  return {
    method: (req.method ?? 'GET').toUpperCase() as HttpMethod,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: lowerHeaders(req.headers),
    body: body === '' ? undefined : body,
    params: {},
  };
}

async function readBody(req: AsyncIterable<Uint8Array | string>): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  }
  return body;
}

function lowerHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined)
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
