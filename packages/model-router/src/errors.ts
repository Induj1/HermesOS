/**
 * Router errors.
 *
 * Two failures are the router's own, distinct from any provider's: there was
 * **no candidate** to try (the criteria matched nothing registered), and **every
 * candidate failed** (the fallback chain was exhausted). Both carry enough to
 * debug a routing decision — what was asked for, and what each provider said.
 */

import type { ModelError } from '@hermes/model';

export type RouterErrorCode = 'NO_CANDIDATES' | 'ALL_FAILED';

export class RouterError extends Error {
  readonly code: RouterErrorCode;

  constructor(code: RouterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** No registered model matched the routing criteria. */
export class NoCandidatesError extends RouterError {
  constructor(detail: string, options?: ErrorOptions) {
    super('NO_CANDIDATES', `No model matched the routing criteria: ${detail}`, options);
  }
}

/** One failed attempt in a fallback chain: which model, and why. */
export interface RouteAttempt {
  readonly model: string;
  readonly provider: string;
  readonly error: Error;
}

/**
 * Every candidate was tried and every one failed.
 *
 * The `attempts` are in try-order, so an operator reads the chain top to bottom.
 * `cause` is the last error — the one that ended the chain — so a `catch` that
 * only inspects `.cause` still sees a real provider failure.
 */
export class AllFailedError extends RouterError {
  readonly attempts: readonly RouteAttempt[];

  constructor(attempts: readonly RouteAttempt[], options?: ErrorOptions) {
    const summary = attempts.map((a) => `${a.model} (${a.error.message})`).join('; ');
    super(
      'ALL_FAILED',
      `All ${String(attempts.length)} candidate model(s) failed: ${summary}`,
      {
        ...options,
        cause: attempts[attempts.length - 1]?.error,
      },
    );
    this.attempts = attempts;
  }
}

/** Narrow a thrown value to a `ModelError` when it is one (by shape, dependency-free). */
export function asModelError(thrown: unknown): ModelError | undefined {
  if (
    thrown instanceof Error &&
    typeof (thrown as { code?: unknown }).code === 'string' &&
    typeof (thrown as { retryable?: unknown }).retryable === 'boolean'
  ) {
    return thrown as ModelError;
  }
  return undefined;
}
