/**
 * HTTP errors.
 *
 * A handler signals a client-facing failure by throwing an {@link HttpError} with
 * a status — `throw new HttpError(404, 'mission not found')` — rather than
 * hand-returning a response and threading it back up. The application's error
 * boundary turns it into a JSON response; an *unexpected* throw (a bug) becomes a
 * `500` that does not leak the message, because a stack trace is not a thing to
 * hand a client.
 */

export class HttpError extends Error {
  readonly status: number;
  /** A stable machine code for the client to branch on, defaulting from the status. */
  readonly code: string;
  /** Extra response headers (e.g. `Allow` on a 405, `WWW-Authenticate` on a 401). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    message: string,
    options?: ErrorOptions & {
      code?: string;
      headers?: Readonly<Record<string, string>>;
    },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
    this.code = options?.code ?? defaultCode(status);
    this.headers = options?.headers ?? {};
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}
