/**
 * Model error classification.
 *
 * These are not tests of wording — the `code` is the contract (RFC-0001 §5).
 * They are tests of **`retryable`**, which is the single field a router branches
 * on and the reason these errors are declared in the contracts at all rather
 * than left to each provider.
 *
 * Getting one wrong is expensive in a way a unit test is unusually good at
 * catching: a `retryable: true` on a malformed request means the same bad call
 * is sent to every provider in the chain and billed for each.
 */

import { describe, expect, it } from 'vitest';
import {
  AuthenticationFailedError,
  ContentFilteredError,
  ContextTooLongError,
  InvalidRequestError,
  isRetryable,
  ModelError,
  ModelTimeoutError,
  ModelUnavailableError,
  RateLimitedError,
  toError,
} from '../src/errors.js';

describe('ModelError', () => {
  it('carries a stable code and the provider that threw', () => {
    const error = new ModelError('MODEL_ERROR', 'ollama', 'something broke');

    expect(error.code).toBe('MODEL_ERROR');
    expect(error.provider).toBe('ollama');
    expect(error.name).toBe('ModelError');
  });

  it('names itself after its concrete subclass', () => {
    expect(new RateLimitedError('openai').name).toBe('RateLimitedError');
  });

  // A failure nobody classified is one nobody thought about, and retrying an
  // unclassified failure across every provider turns one unknown error into N
  // of them plus a bill.
  it('is not retryable unless something said so', () => {
    expect(new ModelError('MODEL_ERROR', 'ollama', 'broke').retryable).toBe(false);
  });

  it('preserves a cause', () => {
    const cause = new Error('socket hang up');

    expect(new ModelError('MODEL_ERROR', 'ollama', 'broke', { cause }).cause).toBe(
      cause,
    );
  });
});

describe('what a router should try elsewhere', () => {
  // The request was fine; someone else can serve it.
  it.each([
    ['the provider is down', new ModelUnavailableError('ollama', 'llama3')],
    ['it did not answer in time', new ModelTimeoutError('ollama', 'llama3', 30_000)],
    ['it is rate limiting us', new RateLimitedError('openai', 1_000)],
  ])('retries when %s', (_label, error) => {
    expect(error.retryable).toBe(true);
    expect(isRetryable(error)).toBe(true);
  });
});

describe('what a router must not try elsewhere', () => {
  // Each of these fails identically at the next provider, so retrying spends
  // money to learn nothing.
  it.each([
    ['the request is malformed', new InvalidRequestError('openai', 'bad schema')],
    ['a safety system declined', new ContentFilteredError('anthropic')],
    ['the prompt does not fit', new ContextTooLongError('openai', 200_000, 128_000)],
    ['the credentials are wrong', new AuthenticationFailedError('openai')],
  ])('does not retry when %s', (_label, error) => {
    expect(error.retryable).toBe(false);
    expect(isRetryable(error)).toBe(false);
  });
});

describe('ContextTooLongError', () => {
  // It looks like a capacity problem, so a router is tempted to reach for a
  // bigger window. But the same oversized prompt fails at three providers and
  // bills for two: the fix is to send less, and only a caller can decide that.
  it('is not retryable even though it looks like one', () => {
    expect(new ContextTooLongError('openai', 200_000, 128_000).retryable).toBe(false);
  });

  it('reports the numbers when it knows them, so a caller can trim to fit', () => {
    const error = new ContextTooLongError('openai', 200_000, 128_000);

    expect(error.tokens).toBe(200_000);
    expect(error.limit).toBe(128_000);
    expect(error.message).toContain('200000 tokens');
    expect(error.message).toContain('accepts 128000');
  });

  it('says something useful when it does not know the numbers', () => {
    const error = new ContextTooLongError('ollama');

    expect(error.tokens).toBeUndefined();
    expect(error.message).toMatch(/longer than ollama will accept/);
  });
});

describe('RateLimitedError', () => {
  it('carries the wait the provider asked for', () => {
    const error = new RateLimitedError('openai', 2_500);

    expect(error.retryAfterMs).toBe(2_500);
    expect(error.message).toContain('retry in 2500ms');
  });

  it('is still retryable when the provider did not say how long', () => {
    const error = new RateLimitedError('openai');

    expect(error.retryAfterMs).toBeUndefined();
    expect(error.retryable).toBe(true);
  });
});

describe('AuthenticationFailedError', () => {
  // Not retryable *here* — but a router moving to another provider is correct,
  // which is why `provider` is on the error.
  it('names the provider whose credentials failed', () => {
    expect(new AuthenticationFailedError('openai').provider).toBe('openai');
  });

  it('includes a reason when given one', () => {
    expect(new AuthenticationFailedError('openai', 'key expired').message).toContain(
      'key expired',
    );
  });
});

describe('isRetryable', () => {
  // An unrecognised failure is one nobody classified. A router that treated
  // every surprise as retryable would turn a bug in one provider's client into
  // a sweep across every provider it has.
  it.each([
    ['a plain Error', new Error('who knows')],
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('says no for %s, which nobody classified', (_label, thrown) => {
    expect(isRetryable(thrown)).toBe(false);
  });
});

describe('toError', () => {
  it('passes an Error through, preserving its identity', () => {
    const original = new ModelUnavailableError('ollama', 'llama3');

    expect(toError(original)).toBe(original);
  });

  it('promotes a thrown string', () => {
    expect(toError('socket hang up').message).toBe('socket hang up');
  });

  it('wraps anything else without losing it', () => {
    const error = toError({ status: 503 });

    expect(error.message).toContain('Non-Error thrown');
    expect(error.cause).toEqual({ status: 503 });
  });
});
