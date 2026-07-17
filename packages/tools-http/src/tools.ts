/**
 * The HTTP tools.
 *
 * Two: `http.get` (read) and `http.request` (any method). They are split so the
 * permission grant can be too — `http.get` declares `net:read`, `http.request`
 * declares `net:write`, and a host that grants only `net:read` gets a
 * read-only HTTP surface, exactly as the filesystem tools give a read-only disk.
 *
 * ## What a model may set, and may not
 *
 * A model sets the URL, and for `http.request` the method, headers, and body.
 * What it may *not* set is anything the {@link guarded} client and the host
 * decided: it cannot turn off SSRF protection, cannot raise the size cap past the
 * host's, and cannot reach a host the policy forbids. The tool is a validated
 * surface; the security lives one layer down, in the client the tool was handed.
 */

import { defineTool, s, type HermesTool } from '@hermes/tools';
import type { HttpClient } from './client.js';

export interface HttpToolsOptions {
  /** Default per-request timeout in ms, capping what a model may ask for. */
  readonly timeoutMs?: number;
  /** Default response-body cap in bytes, capping what a model may ask for. */
  readonly maxBytes?: number;
}

/** The shape both tools return. */
const responseSchema = s.object({
  status: s.number({ integer: true }),
  statusText: s.string(),
  headers: s.unknown({ description: 'Response headers, lower-cased keys.' }),
  body: s.string(),
  url: s.string({ description: 'The final URL, after any redirects.' }),
  truncated: s.boolean({ description: 'True if the body hit the size cap.' }),
});

/**
 * Build the HTTP tools over an injected client.
 *
 * The client is where SSRF protection and redirect re-checking live
 * ({@link guarded}) and where requests are made ({@link FetchHttpClient}). The
 * tools are a thin, validated surface — testable against a `FakeHttpClient` with
 * no server.
 */
export function httpTools(
  client: HttpClient,
  options: HttpToolsOptions = {},
): readonly HermesTool[] {
  const cap = (
    requested: number | undefined,
    limit: number | undefined,
  ): number | undefined => {
    if (requested === undefined) return limit;
    if (limit === undefined) return requested;
    return Math.min(requested, limit);
  };

  const get = defineTool({
    name: 'http.get',
    description:
      'Fetch a URL with a GET request and return its status, headers, and body. ' +
      'Redirects are followed and re-checked against the host policy. A non-2xx ' +
      'status is a normal result, not an error.',
    tags: ['http', 'network', 'read'],
    permissions: ['net:read'],
    idempotent: true,
    input: s.object({
      url: s.string({ description: 'The URL to fetch, http or https.' }),
      headers: s.optional(
        s.unknown({ description: 'Request headers as an object of strings.' }),
      ),
      timeoutMs: s.optional(s.number({ integer: true, minimum: 1 })),
    }),
    output: responseSchema,
    examples: [
      {
        description: 'Fetch a JSON API',
        input: { url: 'https://api.example.com/status' },
      },
    ],
    execute: async ({ url, headers, timeoutMs }, ctx) => {
      const response = await client.request({
        url,
        method: 'GET',
        ...(headers === undefined ? {} : { headers: asHeaders(headers) }),
        ...applyCaps(cap(timeoutMs, options.timeoutMs), options.maxBytes),
        signal: ctx.signal,
      });
      return toOutput(response);
    },
  });

  const request = defineTool({
    name: 'http.request',
    description:
      'Make an HTTP request with any method (GET, POST, PUT, PATCH, DELETE) and ' +
      'return the response. Use for anything that changes state. Redirects are ' +
      'followed and re-checked. A non-2xx status is a normal result, not an error.',
    tags: ['http', 'network', 'write'],
    permissions: ['net:write'],
    idempotent: false,
    input: s.object({
      url: s.string({ description: 'The URL, http or https.' }),
      method: s.withDefault(
        s.enumOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
        'GET',
      ),
      headers: s.optional(
        s.unknown({ description: 'Request headers as an object of strings.' }),
      ),
      body: s.optional(
        s.string({ description: 'The request body, e.g. a JSON string.' }),
      ),
      timeoutMs: s.optional(s.number({ integer: true, minimum: 1 })),
    }),
    output: responseSchema,
    examples: [
      {
        description: 'Post JSON',
        input: {
          url: 'https://api.example.com/items',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"name":"x"}',
        },
      },
    ],
    execute: async ({ url, method, headers, body, timeoutMs }, ctx) => {
      const response = await client.request({
        url,
        method,
        ...(headers === undefined ? {} : { headers: asHeaders(headers) }),
        ...(body === undefined ? {} : { body }),
        ...applyCaps(cap(timeoutMs, options.timeoutMs), options.maxBytes),
        signal: ctx.signal,
      });
      return toOutput(response);
    },
  });

  return [get, request];
}

function applyCaps(
  timeoutMs: number | undefined,
  maxBytes: number | undefined,
): {
  timeoutMs?: number;
  maxBytes?: number;
} {
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

/**
 * Coerce a model's `headers` object into `Record<string, string>`.
 *
 * The schema types it as `unknown` — a model may send a number for a header
 * value, or nest an object — so it is narrowed here rather than trusted. Non-string
 * values are stringified rather than rejected: a model sending `{ 'x-count': 5 }`
 * meant the header `5`, and refusing the whole request over it wastes a turn. A
 * value that is not a primitive is dropped, because there is no honest string for
 * `{ nested: true }` as a header.
 */
function asHeaders(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean')
      out[key] = String(value);
  }
  return out;
}

function toOutput(response: {
  status: number;
  statusText: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  url: string;
  truncated: boolean;
}): {
  status: number;
  statusText: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  url: string;
  truncated: boolean;
} {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    url: response.url,
    truncated: response.truncated,
  };
}
