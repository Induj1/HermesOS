/**
 * Token estimation — the heuristic and per-message overhead.
 */

import { describe, expect, it } from 'vitest';
import { charEstimator, estimateMessage } from '../src/estimate.js';
import { assistant, user } from '@hermes/model';

describe('charEstimator', () => {
  it('is zero for empty text and ~chars/4 otherwise', () => {
    expect(charEstimator('')).toBe(0);
    expect(charEstimator('abcd')).toBe(1);
    expect(charEstimator('abcde')).toBe(2); // ceil(5/4)
  });

  it('floors non-empty short text at 1 token', () => {
    expect(charEstimator('a')).toBe(1);
  });
});

describe('estimateMessage', () => {
  it('adds a per-message overhead to the content estimate', () => {
    // content 'abcd' → 1, + overhead 4 = 5
    expect(estimateMessage(user('abcd'), charEstimator)).toBe(5);
  });

  it('counts a name', () => {
    expect(estimateMessage(user('abcd', 'abcd'), charEstimator)).toBe(6); // +1 for name
  });

  it('counts tool-call name and arguments', () => {
    const msg = assistant('', [{ id: 'c', name: 'search', args: { q: 'x' } }]);
    // content '' → 0, overhead 4, name 'search' → 2, args '{"q":"x"}' (9) → 3
    expect(estimateMessage(msg, charEstimator)).toBe(4 + 2 + 3);
  });

  it('respects a custom overhead', () => {
    expect(estimateMessage(user('abcd'), charEstimator, 0)).toBe(1);
  });

  it('handles a tool call with no arguments', () => {
    const msg = assistant('', [{ id: 'c', name: 'ping', args: undefined }]);
    // overhead 4, name 'ping' → 1, args '{}' (2 chars) → 1
    expect(estimateMessage(msg, charEstimator)).toBe(4 + 1 + 1);
  });

  it('accepts a custom estimator', () => {
    const words: (t: string) => number = (t) => (t === '' ? 0 : t.split(/\s+/).length);
    expect(estimateMessage(user('one two three'), words, 0)).toBe(3);
  });
});
