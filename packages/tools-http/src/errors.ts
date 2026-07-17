/**
 * HTTP errors.
 *
 * The distinction that matters, as with the shell package: **"could not make the
 * request" versus "the server answered with an error status".** A 404 or a 500 is
 * *not* an error here — it is an `HttpResponse` with that status, because a
 * response an agent should reason about ("the resource is gone", "the API is
 * down") is information, not an exception. An `HttpError` means no usable response
 * came back: the URL was blocked, the request timed out, the body was too large,
 * or the connection failed.
 *
 * Same contract as every layer: a stable `code`, message wording free to change
 * (RFC-0001 §5), no relation to `KernelError`.
 */

export type HttpErrorCode =
  'BLOCKED' | 'TIMEOUT' | 'TOO_LARGE' | 'TOO_MANY_REDIRECTS' | 'NETWORK_ERROR';

export class HttpError extends Error {
  readonly code: HttpErrorCode;
  /** The URL that failed. Always present. */
  readonly url: string;

  constructor(
    code: HttpErrorCode,
    url: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${url})`, options);
    this.name = new.target.name;
    this.code = code;
    this.url = url;
  }
}

/**
 * A request refused by the host policy.
 *
 * The SSRF block, surfaced. Its own subclass because a caller — and a model —
 * must learn this is not a retry-with-different-arguments problem: the host is
 * not allowed, and asking again for the same host will fail the same way.
 */
export class BlockedError extends HttpError {
  constructor(url: string, reason: string) {
    super('BLOCKED', url, `blocked: ${reason}`);
  }
}
