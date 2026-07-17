/**
 * GitHub errors.
 *
 * A `GitHubError` means an API call came back with a status the caller cannot
 * treat as success, mapped to a stable code so a caller can branch on it without
 * matching HTTP numbers or GitHub's prose. The interesting one is
 * {@link RateLimitError}: rate limiting is not a generic failure but a *wait this
 * long and retry* signal, so it carries the reset time the client (and a caller)
 * needs to act on it.
 *
 * The mapping from status to code lives in {@link classifyStatus}, kept here so
 * the REST and GraphQL clients classify identically.
 */

export type GitHubErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'SERVER_ERROR'
  | 'GRAPHQL_ERROR'
  | 'REQUEST_FAILED';

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  /** The HTTP status, when the failure came from a response. */
  readonly status: number | undefined;
  /** GitHub's parsed error body, when there was one. What a human debugs with. */
  readonly response: unknown;

  constructor(
    code: GitHubErrorCode,
    message: string,
    options?: ErrorOptions & { status?: number; response?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.status = options?.status;
    this.response = options?.response;
  }
}

/**
 * A rate-limit rejection carrying when the limit resets.
 *
 * Both of GitHub's throttles land here: the primary limit (a quota that refills
 * at a fixed time, in `x-ratelimit-reset`) and a secondary/abuse limit (a
 * cooldown in `retry-after`). `retryAt` is epoch milliseconds — the earliest a
 * retry could succeed — so a caller waits on a concrete instant rather than
 * re-deriving it.
 */
export class RateLimitError extends GitHubError {
  readonly retryAt: number;

  constructor(
    message: string,
    retryAt: number,
    options?: { status?: number; response?: unknown },
  ) {
    super('RATE_LIMITED', message, options);
    this.retryAt = retryAt;
  }
}

/** Map an HTTP status to a stable code. 2xx is not an error and is not mapped. */
export function classifyStatus(status: number): GitHubErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      // A 403 may be a rate limit or a genuine permission denial; the client
      // distinguishes them from the headers before constructing the error. This
      // is the fallback when it is a plain forbidden.
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_FAILED';
    default:
      return status >= 500 ? 'SERVER_ERROR' : 'REQUEST_FAILED';
  }
}

/** A human message from GitHub's error body, if it has the usual shape. */
export function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message: unknown = body.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return fallback;
}
