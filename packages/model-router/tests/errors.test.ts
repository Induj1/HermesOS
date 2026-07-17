/**
 * Router errors and the ModelError shape-check.
 */

import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '@hermes/model';
import {
  AllFailedError,
  NoCandidatesError,
  RouterError,
  asModelError,
} from '../src/errors.js';

describe('NoCandidatesError', () => {
  it('has code NO_CANDIDATES', () => {
    const err = new NoCandidatesError('nothing matched');
    expect(err).toBeInstanceOf(RouterError);
    expect(err.code).toBe('NO_CANDIDATES');
    expect(err.message).toContain('nothing matched');
  });
});

describe('AllFailedError', () => {
  it('summarises attempts and carries the last error as cause', () => {
    const attempts = [
      { model: 'a', provider: 'p', error: new Error('down') },
      { model: 'b', provider: 'q', error: new Error('busy') },
    ];
    const err = new AllFailedError(attempts);
    expect(err.code).toBe('ALL_FAILED');
    expect(err.attempts).toHaveLength(2);
    expect(err.message).toContain('a (down)');
    expect(err.message).toContain('b (busy)');
    expect(err.cause).toBe(attempts[1]?.error);
  });

  it('tolerates an empty attempt list', () => {
    expect(new AllFailedError([]).cause).toBeUndefined();
  });
});

describe('asModelError', () => {
  it('recognises a ModelError by its shape', () => {
    expect(asModelError(new RateLimitedError('p'))).toBeInstanceOf(RateLimitedError);
  });

  it('returns undefined for a plain Error or non-error', () => {
    expect(asModelError(new Error('x'))).toBeUndefined();
    expect(asModelError('string')).toBeUndefined();
    expect(asModelError({ code: 'X', retryable: true })).toBeUndefined(); // not an Error instance
  });
});
