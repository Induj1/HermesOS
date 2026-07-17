/**
 * Every error a model provider should throw.
 *
 * Declared here, in the contracts, rather than left to each provider — and that
 * is the whole point of them. A router that falls back from Claude to Ollama has
 * to answer one question about a failure: *is it worth trying someone else?* A
 * rate limit is; a malformed request is not, and retrying it elsewhere just
 * fails twice and bills for it.
 *
 * If each provider threw its own shapes, that question would be answered by
 * matching on message text per provider, which is the thing that breaks silently
 * when a vendor rewords a string. So `retryable` is on the base class and it is
 * the contract.
 *
 * Same rules as the rest of the platform: a stable `code` that callers branch on,
 * message wording free to change (RFC-0001 §5), and no relation to `KernelError`
 * — the kernel has never heard of a model.
 */

export type ModelErrorCode =
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_TIMEOUT'
  | 'RATE_LIMITED'
  | 'CONTEXT_TOO_LONG'
  | 'CONTENT_FILTERED'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'MODEL_ERROR';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  /** Which provider threw. What a router logs and what an operator pages on. */
  readonly provider: string;
  /**
   * Would the same call somewhere else — or later — plausibly work?
   *
   * The single field a router actually branches on. It is a *property of the
   * failure*, not advice: `RATE_LIMITED` is retryable because the request was
   * fine, and `INVALID_REQUEST` is not because it will be just as invalid on the
   * next provider.
   */
  readonly retryable: boolean;

  constructor(
    code: ModelErrorCode,
    provider: string,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.provider = provider;
    // Defaults to false. A failure nobody classified is one nobody thought
    // about, and retrying an unclassified failure across every provider in a
    // chain turns one unknown error into N of them plus a bill.
    this.retryable = options?.retryable ?? false;
  }
}

/** The provider is down, unreachable, or not serving this model. */
export class ModelUnavailableError extends ModelError {
  constructor(provider: string, model: string, options?: ErrorOptions) {
    super(
      'MODEL_UNAVAILABLE',
      provider,
      `Model "${model}" is not available from ${provider}.`,
      {
        ...options,
        // Another provider very likely has a comparable model up.
        retryable: true,
      },
    );
  }
}

/** It did not answer in time. */
export class ModelTimeoutError extends ModelError {
  constructor(provider: string, model: string, ms: number, options?: ErrorOptions) {
    super(
      'MODEL_TIMEOUT',
      provider,
      `Model "${model}" from ${provider} did not respond within ${String(ms)}ms.`,
      { ...options, retryable: true },
    );
  }
}

/** Too many requests. */
export class RateLimitedError extends ModelError {
  /** When the provider said to come back, in ms. Absent if it did not say. */
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, retryAfterMs?: number, options?: ErrorOptions) {
    super(
      'RATE_LIMITED',
      provider,
      retryAfterMs === undefined
        ? `${provider} is rate limiting this client.`
        : `${provider} is rate limiting this client; retry in ${String(retryAfterMs)}ms.`,
      { ...options, retryable: true },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The prompt does not fit.
 *
 * **Not retryable**, and this is the one worth arguing about. It looks like a
 * capacity problem, so a router is tempted to try a model with a bigger window.
 * But the same oversized prompt sent to three providers fails three times and
 * bills for two, and the fix is never "ask someone else" — it is to send less.
 * A caller that genuinely wants a larger window can catch this and choose one; a
 * router must not do it silently.
 */
export class ContextTooLongError extends ModelError {
  readonly tokens: number | undefined;
  readonly limit: number | undefined;

  constructor(
    provider: string,
    tokens?: number,
    limit?: number,
    options?: ErrorOptions,
  ) {
    super(
      'CONTEXT_TOO_LONG',
      provider,
      tokens === undefined || limit === undefined
        ? `The prompt is longer than ${provider} will accept.`
        : `The prompt is ${String(tokens)} tokens; ${provider} accepts ${String(limit)}.`,
      { ...options, retryable: false },
    );
    this.tokens = tokens;
    this.limit = limit;
  }
}

/**
 * A safety system stopped it.
 *
 * Not retryable, and deliberately its own code rather than a generic error: a
 * caller may legitimately want to handle a refusal differently from a fault —
 * telling a user their request was declined is not the same as telling them the
 * system broke.
 */
export class ContentFilteredError extends ModelError {
  constructor(provider: string, reason?: string, options?: ErrorOptions) {
    super(
      'CONTENT_FILTERED',
      provider,
      reason === undefined
        ? `${provider} declined to answer on safety grounds.`
        : `${provider} declined to answer on safety grounds: ${reason}.`,
      { ...options, retryable: false },
    );
  }
}

/** The request is wrong. It will be just as wrong at the next provider. */
export class InvalidRequestError extends ModelError {
  constructor(provider: string, message: string, options?: ErrorOptions) {
    super('INVALID_REQUEST', provider, `${provider} rejected the request: ${message}`, {
      ...options,
      retryable: false,
    });
  }
}

/**
 * The credentials are missing, wrong, or expired.
 *
 * Not retryable *at this provider*. A router falling back to another one is
 * correct and expected — that is the whole point of `provider` being on the
 * error — but hammering this one with the same bad key is not.
 */
export class AuthenticationFailedError extends ModelError {
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

/**
 * Coerce anything thrown into an `Error`.
 *
 * Each layer keeps its own rather than importing another's: this package has no
 * dependencies at all, and taking one to convert an error would be a strange
 * place to acquire the first.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}

/**
 * Is this worth trying somewhere else?
 *
 * The router's whole question, in one place. A non-`ModelError` answers **no**:
 * an unrecognised failure is one nobody classified, and a router that treated
 * every surprise as retryable would turn a bug in one provider's client into a
 * sweep across every provider it has.
 */
export function isRetryable(thrown: unknown): boolean {
  return thrown instanceof ModelError && thrown.retryable;
}
