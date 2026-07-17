/**
 * The error hierarchy and its one load-bearing property: retryable.
 */

import { describe, expect, it } from 'vitest';
import {
  EmbeddingError,
  RateLimitedError,
  EmbeddingTimeoutError,
  EmbeddingCancelledError,
  UnknownModelError,
  InvalidRequestError,
  MalformedResponseError,
  DimensionMismatchError,
  AuthenticationFailedError,
  isRetryable,
  toError,
} from '../src/errors.js';

describe('EmbeddingError', () => {
  it('carries a code, provider, and defaults retryable to false', () => {
    const err = new EmbeddingError('PROVIDER_ERROR', 'openai', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.provider).toBe('openai');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('EmbeddingError');
  });
});

describe('retryability by type', () => {
  const retryable = [
    new RateLimitedError('p', 500),
    new EmbeddingTimeoutError('p', 1000),
    new MalformedResponseError('p', 'corrupt'),
  ];
  const notRetryable = [
    new EmbeddingCancelledError('p'),
    new UnknownModelError('p', 'x'),
    new InvalidRequestError('p', 'bad'),
    new DimensionMismatchError('p', 8, 7),
    new AuthenticationFailedError('p'),
  ];

  for (const err of retryable) {
    it(`${err.code} is retryable`, () => {
      expect(err.retryable).toBe(true);
    });
  }
  for (const err of notRetryable) {
    it(`${err.code} is not retryable`, () => {
      expect(err.retryable).toBe(false);
    });
  }
});

describe('specific fields', () => {
  it('RateLimitedError carries retryAfterMs', () => {
    expect(new RateLimitedError('p', 750).retryAfterMs).toBe(750);
    expect(new RateLimitedError('p').retryAfterMs).toBeUndefined();
  });

  it('DimensionMismatchError carries expected and actual', () => {
    const err = new DimensionMismatchError('p', 8, 16);
    expect(err.expected).toBe(8);
    expect(err.actual).toBe(16);
  });

  it('MalformedResponseError can be made non-retryable (a NaN vector)', () => {
    expect(new MalformedResponseError('p', 'nan', { retryable: false }).retryable).toBe(
      false,
    );
  });
});

describe('isRetryable / toError', () => {
  it('answers no for a non-EmbeddingError', () => {
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isRetryable('a string')).toBe(false);
    expect(isRetryable(new RateLimitedError('p'))).toBe(true);
  });

  it('coerces anything into an Error', () => {
    expect(toError(new Error('x')).message).toBe('x');
    expect(toError('str').message).toBe('str');
    expect(toError(42).message).toContain('42');
  });
});
