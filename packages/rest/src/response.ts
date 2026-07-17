/**
 * Response constructors and body parsing — the small helpers a handler reaches
 * for, so it never hand-builds a `{ status, headers, body }` or forgets a
 * `content-type`.
 */

import { HttpError } from './errors.js';
import type { HttpRequest, HttpResponse } from './types.js';

/** A JSON response. Serializes `body` and sets `content-type`. */
export function json(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

/** A plain-text response. */
export function text(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    body,
  };
}

/** A `204 No Content` response. */
export function noContent(
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return { status: 204, headers, body: undefined };
}

/**
 * Parse a request's JSON body, or throw a `400` `HttpError`.
 *
 * A handler that wants a typed body calls this rather than `JSON.parse(req.body)`,
 * so a malformed or absent body becomes a clean `400` the error middleware renders
 * — not an unhandled `SyntaxError` that surfaces as a `500`.
 */
// The generic is an ergonomic assertion (`jsonBody<Mission>(req)`), like `res.json<T>()`
// — the caller names the shape it expects; a Validator is where it is actually checked.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function jsonBody<T = unknown>(request: HttpRequest): T {
  if (request.body === undefined || request.body === '') {
    throw new HttpError(400, 'the request body is required');
  }
  try {
    return JSON.parse(request.body) as T;
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON');
  }
}
