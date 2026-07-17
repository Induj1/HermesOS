/**
 * Status classification and the error shapes.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyStatus,
  GitHubError,
  RateLimitError,
  messageFromBody,
} from '../src/errors.js';

describe('classifyStatus', () => {
  const cases: readonly [number, string][] = [
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'VALIDATION_FAILED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [400, 'REQUEST_FAILED'],
    [418, 'REQUEST_FAILED'],
  ];
  for (const [status, code] of cases) {
    it(`maps ${String(status)} to ${code}`, () => {
      expect(classifyStatus(status)).toBe(code);
    });
  }
});

describe('GitHubError', () => {
  it('carries a code, status, and the response body', () => {
    const err = new GitHubError('NOT_FOUND', 'gone', {
      status: 404,
      response: { message: 'Not Found' },
    });
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.response).toEqual({ message: 'Not Found' });
    expect(err.name).toBe('GitHubError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('RateLimitError', () => {
  it('is a GitHubError with code RATE_LIMITED and a retry instant', () => {
    const err = new RateLimitError('slow down', 1_700_000_000_000, { status: 429 });
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAt).toBe(1_700_000_000_000);
    expect(err.status).toBe(429);
  });
});

describe('messageFromBody', () => {
  it('reads GitHub-shaped { message }', () => {
    expect(messageFromBody({ message: 'Bad credentials' }, 'fb')).toBe(
      'Bad credentials',
    );
  });

  it('falls back when there is no usable message', () => {
    expect(messageFromBody({ foo: 1 }, 'fb')).toBe('fb');
    expect(messageFromBody('a string', 'fb')).toBe('fb');
    expect(messageFromBody({ message: '' }, 'fb')).toBe('fb');
    expect(messageFromBody(null, 'fb')).toBe('fb');
  });
});
