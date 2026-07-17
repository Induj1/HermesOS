/**
 * Every error the embedding platform throws.
 *
 * The design mirrors `@hermes/model`'s `ModelError` for the same reason: the one
 * question a caller — or a future model router — asks about a failure is *is it
 * worth trying again, or somewhere else?* That is `retryable`, and it is a
 * property of the failure, not advice. A rate limit is retryable (the request was
 * fine); an unknown model is not (it will be unknown on the next call too).
 *
 * A stable `code` callers branch on, message wording free to change (RFC-0001
 * §5), `provider` for logging, and no relation to `KernelError`.
 */

export type EmbeddingErrorCode =
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNKNOWN_MODEL'
  | 'INVALID_REQUEST'
  | 'MALFORMED_RESPONSE'
  | 'DIMENSION_MISMATCH'
  | 'AUTHENTICATION_FAILED'
  | 'PROVIDER_ERROR';

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  /** Which provider threw. What an operator pages on. */
  readonly provider: string;
  /** Would the same call — later, or elsewhere — plausibly work? */
  readonly retryable: boolean;

  constructor(
    code: EmbeddingErrorCode,
    provider: string,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.provider = provider;
    // Defaults to false: an unclassified failure is one nobody reasoned about,
    // and retrying it across a chain turns one bug into N plus a bill.
    this.retryable = options?.retryable ?? false;
  }
}

/** Too many requests. Retryable, and carries when to come back if the provider said. */
export class RateLimitedError extends EmbeddingError {
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, retryAfterMs?: number, options?: ErrorOptions) {
    super(
      'RATE_LIMITED',
      provider,
      retryAfterMs === undefined
        ? `${provider} is rate limiting embedding requests.`
        : `${provider} is rate limiting embedding requests; retry in ${String(retryAfterMs)}ms.`,
      { ...options, retryable: true },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

/** A call did not finish within its timeout. Retryable. */
export class EmbeddingTimeoutError extends EmbeddingError {
  constructor(provider: string, ms: number, options?: ErrorOptions) {
    super('TIMEOUT', provider, `${provider} did not respond within ${String(ms)}ms.`, {
      ...options,
      retryable: true,
    });
  }
}

/** The caller aborted. Never retryable — the caller asked to stop. */
export class EmbeddingCancelledError extends EmbeddingError {
  constructor(provider: string, options?: ErrorOptions) {
    super('CANCELLED', provider, `The embedding request was cancelled.`, {
      ...options,
      retryable: false,
    });
  }
}

/** No such model at this provider. Not retryable. */
export class UnknownModelError extends EmbeddingError {
  constructor(provider: string, model: string, options?: ErrorOptions) {
    super('UNKNOWN_MODEL', provider, `Model "${model}" is not served by ${provider}.`, {
      ...options,
      retryable: false,
    });
  }
}

/** The request is malformed (empty, over a limit the caller can see). Not retryable. */
export class InvalidRequestError extends EmbeddingError {
  constructor(provider: string, message: string, options?: ErrorOptions) {
    super('INVALID_REQUEST', provider, `${provider} rejected the request: ${message}`, {
      ...options,
      retryable: false,
    });
  }
}

/**
 * The provider returned something unusable — wrong count, non-array, non-finite.
 *
 * Retryable by default: a corrupt response is often a transient glitch, and a
 * single retry is cheap insurance. A caller that disagrees can inspect the code.
 */
export class MalformedResponseError extends EmbeddingError {
  constructor(
    provider: string,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(
      'MALFORMED_RESPONSE',
      provider,
      `${provider} returned a malformed response: ${message}`,
      {
        ...options,
        retryable: options?.retryable ?? true,
      },
    );
  }
}

/**
 * A vector's width is not what the model promised.
 *
 * Its own code, and **not** retryable: a mismatched width is a configuration
 * error (wrong model, wrong `dimensions`), and it will be just as wrong next time.
 */
export class DimensionMismatchError extends EmbeddingError {
  readonly expected: number;
  readonly actual: number;

  constructor(
    provider: string,
    expected: number,
    actual: number,
    options?: ErrorOptions,
  ) {
    super(
      'DIMENSION_MISMATCH',
      provider,
      `${provider} returned a vector of width ${String(actual)}; expected ${String(expected)}.`,
      { ...options, retryable: false },
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/** The credentials are missing or wrong. Not retryable at this provider. */
export class AuthenticationFailedError extends EmbeddingError {
  constructor(provider: string, message?: string, options?: ErrorOptions) {
    super(
      'AUTHENTICATION_FAILED',
      provider,
      message === undefined
        ? `${provider} rejected the credentials.`
        : `${provider} rejected the credentials: ${message}`,
      { ...options, retryable: false },
    );
  }
}

/** Coerce anything thrown into an Error. */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}

/** Is this worth retrying? A non-`EmbeddingError` answers no. */
export function isRetryable(thrown: unknown): boolean {
  return thrown instanceof EmbeddingError && thrown.retryable;
}
