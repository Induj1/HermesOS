/**
 * The real HTTP client, backed by the platform's global `fetch`.
 *
 * The only file that touches the network. It does exactly one request with
 * **`redirect: 'manual'`** — it never follows a redirect itself, because
 * following one is a security decision that belongs to {@link guarded}, not to
 * the thing that makes the call.
 *
 * Two bounds live here because only the thing holding the connection can enforce
 * them: a **timeout** (via an `AbortController`), and a **streaming size cap** —
 * the body is read chunk by chunk and the connection is dropped the moment it
 * crosses the limit, so a 2 GB response never lands in memory. Buffering the whole
 * body and then measuring it would have already paid the cost the cap exists to
 * prevent.
 */

import { HttpError } from './errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from './client.js';

export interface FetchHttpClientOptions {
  /** Default request timeout in ms. 30_000. */
  readonly timeoutMs?: number;
  /** Default response-body cap in bytes. 5 MiB. */
  readonly maxBytes?: number;
  /**
   * The `fetch` to use. Defaults to the global one.
   *
   * Injected so a test can drive the client without a real server, and so a host
   * can supply a `fetch` with its own connection pooling or proxy. The default is
   * `globalThis.fetch`, present on Node 22+.
   */
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class FetchHttpClient implements HttpClient {
  readonly #options: FetchHttpClientOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FetchHttpClientOptions = {}) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = req.maxBytes ?? this.#options.maxBytes ?? DEFAULT_MAX_BYTES;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new HttpError('TIMEOUT', req.url, `timed out after ${String(timeoutMs)}ms`),
      );
    }, timeoutMs);
    // Honour the caller's signal too. The `aborted` check is not redundant with
    // the listener: `addEventListener('abort')` never fires for a signal that is
    // *already* aborted (the event has been and gone), so a pre-aborted request
    // would otherwise run to completion. Check now, and listen for a later abort.
    const onCallerAbort = (): void => {
      controller.abort(req.signal?.reason);
    };
    if (req.signal?.aborted === true) controller.abort(req.signal.reason);
    else req.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const response = await this.#fetch(req.url, {
        method: (req.method ?? 'GET').toUpperCase(),
        ...(req.headers === undefined ? {} : { headers: { ...req.headers } }),
        ...(req.body === undefined ? {} : { body: req.body }),
        // Never follow a redirect here. The guard re-checks each hop; a client
        // that followed would bypass it.
        redirect: 'manual',
        signal: controller.signal,
      });

      const { body, truncated } = await readCapped(req.url, response, maxBytes);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        body,
        url: response.url === '' ? req.url : response.url,
        truncated,
        // The guard sets the real count; a single request has followed none.
        redirects: 0,
      };
    } catch (thrown) {
      throw toHttpError(req.url, thrown);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Read a response body, stopping at the cap.
 *
 * Streamed rather than `response.text()`-ed, so an oversized body is abandoned
 * mid-flight rather than fully downloaded and then rejected. The connection is
 * cancelled the moment the cap is crossed.
 */
async function readCapped(
  url: string,
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) return { body: '', truncated: false };

  // Typed explicitly: `ReadableStream<Uint8Array>` narrows the reader so `value`
  // is `Uint8Array` rather than the `any` a bare `response.body` reader gives,
  // which is what lets `value.length` and `value.subarray` be checked.
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        truncated = true;
        await reader.cancel();
        // Keep only up to the cap, so the returned body is bounded even on the
        // chunk that crossed it.
        chunks.push(value.subarray(0, value.length - (total - maxBytes)));
        break;
      }
      chunks.push(value);
    }
  } catch (thrown) {
    throw toHttpError(url, thrown);
  }

  return { body: new TextDecoder().decode(concat(chunks)), truncated };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Turn a fetch/abort failure into an {@link HttpError}, keeping our own shapes. */
function toHttpError(url: string, thrown: unknown): HttpError {
  if (thrown instanceof HttpError) return thrown;
  // The timeout aborts with an HttpError as the reason; an abort surfaces it here.
  if (thrown instanceof DOMException && thrown.name === 'AbortError') {
    return new HttpError('TIMEOUT', url, 'the request was aborted', { cause: thrown });
  }
  return new HttpError(
    'NETWORK_ERROR',
    url,
    thrown instanceof Error ? thrown.message : String(thrown),
    { cause: thrown },
  );
}
