/**
 * Normalization and validation — pure, so exhaustively testable.
 */

import { describe, expect, it } from 'vitest';
import { l2normalize, assertVector, assertBatch } from '../src/normalize.js';
import { DimensionMismatchError, MalformedResponseError } from '../src/errors.js';

describe('l2normalize', () => {
  it('scales a vector to unit length', () => {
    const unit = l2normalize([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6);
    expect(unit[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...unit)).toBeCloseTo(1);
  });

  it('leaves a zero vector unchanged rather than dividing by zero', () => {
    expect(l2normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('is idempotent on an already-unit vector', () => {
    const once = l2normalize([1, 2, 2]);
    const twice = l2normalize(once);
    for (let i = 0; i < once.length; i += 1) expect(twice[i]).toBeCloseTo(once[i] ?? 0);
  });
});

describe('assertVector', () => {
  it('accepts a correct vector', () => {
    expect(() => {
      assertVector('p', 3, [0.1, 0.2, 0.3]);
    }).not.toThrow();
  });

  it('rejects a wrong width with DimensionMismatchError', () => {
    expect(() => {
      assertVector('p', 3, [0.1, 0.2]);
    }).toThrow(DimensionMismatchError);
  });

  it('rejects a non-finite value with MalformedResponseError', () => {
    expect(() => {
      assertVector('p', 2, [0.1, Number.NaN]);
    }).toThrow(MalformedResponseError);
    expect(() => {
      assertVector('p', 2, [0.1, Number.POSITIVE_INFINITY]);
    }).toThrow(MalformedResponseError);
  });
});

describe('assertBatch', () => {
  it('accepts the right count of correct vectors', () => {
    expect(() => {
      assertBatch(
        'p',
        2,
        [
          [1, 2],
          [3, 4],
        ],
        2,
      );
    }).not.toThrow();
  });

  it('rejects a wrong count', () => {
    expect(() => {
      assertBatch('p', 2, [[1, 2]], 2);
    }).toThrow(/expected 2 vectors, received 1/);
  });

  it('rejects a missing (undefined) vector', () => {
    const vectors = [[1, 2], undefined] as unknown as number[][];
    expect(() => {
      assertBatch('p', 2, vectors, 2);
    }).toThrow(MalformedResponseError);
  });

  it('propagates a per-vector width failure', () => {
    expect(() => {
      assertBatch('p', 2, [[1, 2], [3]], 2);
    }).toThrow(DimensionMismatchError);
  });
});
