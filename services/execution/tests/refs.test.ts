/**
 * Step reference behaviour.
 *
 * `refs.ts` is the mechanism the whole package exists to provide, and it is
 * pure — a lookup in, a value out — so it is tested against plain objects rather
 * than a running engine. Everything interesting about data flow is decided here;
 * `engine.test.ts` only proves it survives a real kernel.
 */

import { describe, expect, it } from 'vitest';
import {
  containsRef,
  isStepRef,
  referencedSteps,
  resolveRefs,
  validateRefs,
  type ResultLookup,
} from '../src/refs.js';
import { InvalidReferenceError } from '../src/errors.js';

/** A lookup over a plain object. Only succeeded steps are in it, by construction. */
function lookup(results: Record<string, unknown>): ResultLookup {
  return {
    has: (step) => step in results,
    get: (step) => results[step],
  };
}

describe('isStepRef', () => {
  it('recognises a reference', () => {
    expect(isStepRef({ $from: 'a' })).toBe(true);
    expect(isStepRef({ $from: 'a', path: 'x.y' })).toBe(true);
  });

  it.each([
    ['a plain object', { from: 'a' }],
    ['null', null],
    ['a string', 'a'],
    ['an array', [{ $from: 'a' }]],
    ['a number', 1],
  ])('does not mistake %s for one', (_label, value) => {
    expect(isStepRef(value)).toBe(false);
  });

  // Narrow on purpose: guessing at the author's intent would silently substitute
  // the wrong thing. A malformed reference is caught by validateRefs instead.
  it('rejects a malformed reference rather than guessing at it', () => {
    expect(isStepRef({ $from: 42 })).toBe(false);
    expect(isStepRef({ $from: 'a', path: 7 })).toBe(false);
  });
});

describe('containsRef', () => {
  it('finds a reference at any depth', () => {
    expect(containsRef({ $from: 'a' })).toBe(true);
    expect(containsRef({ deep: { nested: [{ $from: 'a' }] } })).toBe(true);
  });

  it.each([
    ['plain data', { a: 1, b: ['x'] }],
    ['null', null],
    ['undefined', undefined],
    ['a primitive', 'text'],
  ])('says no for %s', (_label, value) => {
    expect(containsRef(value)).toBe(false);
  });
});

describe('referencedSteps', () => {
  it('collects every referenced step, deduplicated', () => {
    const input = { a: { $from: 'one' }, b: [{ $from: 'two' }, { $from: 'one' }] };

    expect([...referencedSteps(input)].sort()).toEqual(['one', 'two']);
  });

  it('is empty for plain data', () => {
    expect(referencedSteps({ a: 1 })).toEqual([]);
  });
});

describe('resolveRefs', () => {
  it('substitutes a whole result', () => {
    expect(resolveRefs({ $from: 'a' }, lookup({ a: { n: 1 } }))).toEqual({ n: 1 });
  });

  it('substitutes inside an object', () => {
    const resolved = resolveRefs({ x: { $from: 'a' }, y: 'literal' }, lookup({ a: 1 }));

    expect(resolved).toEqual({ x: 1, y: 'literal' });
  });

  // A model writing a plan will nest, and a resolver that only looked at
  // top-level keys would fail in a way that looks like the model's fault.
  it('substitutes deep inside arrays and objects', () => {
    const resolved = resolveRefs(
      { items: [{ value: { $from: 'a' } }, { value: 'plain' }] },
      lookup({ a: 'resolved' }),
    );

    expect(resolved).toEqual({ items: [{ value: 'resolved' }, { value: 'plain' }] });
  });

  it('leaves plain data untouched', () => {
    const input = { a: 1, b: [true, null], c: 'x' };

    expect(resolveRefs(input, lookup({}))).toEqual(input);
  });

  // Resolution runs again on every retry and every resume, so it has to be
  // repeatable rather than destructive.
  it('does not mutate its input', () => {
    const input = { x: { $from: 'a' } };

    resolveRefs(input, lookup({ a: 1 }));

    expect(input).toEqual({ x: { $from: 'a' } });
  });

  it('reads a path into an object', () => {
    expect(
      resolveRefs({ $from: 'a', path: 'x.y' }, lookup({ a: { x: { y: 7 } } })),
    ).toBe(7);
  });

  it('reads a numeric segment as an array index', () => {
    expect(
      resolveRefs(
        { $from: 'a', path: 'items.1' },
        lookup({ a: { items: ['x', 'y'] } }),
      ),
    ).toBe('y');
  });

  // A step legitimately returning `{ found: false }` or `{ value: null }` must
  // resolve to that value, not be reported as missing.
  it.each([
    ['false', false],
    ['null', null],
    ['zero', 0],
    ['an empty string', ''],
  ])('resolves a path to %s rather than calling it missing', (_label, value) => {
    expect(resolveRefs({ $from: 'a', path: 'v' }, lookup({ a: { v: value } }))).toBe(
      value,
    );
  });

  it('resolves a step whose whole result is undefined', () => {
    // A void tool still succeeded. `has()` keys off state, never off the value.
    expect(resolveRefs({ $from: 'a' }, lookup({ a: undefined }))).toBeUndefined();
  });

  describe('when it cannot resolve', () => {
    it('throws for a step with no result, naming it', () => {
      expect(() => resolveRefs({ $from: 'ghost' }, lookup({}))).toThrow(
        InvalidReferenceError,
      );
      expect(() => resolveRefs({ $from: 'ghost' }, lookup({}))).toThrow(/ghost/);
    });

    it('explains that the step has not run or did not succeed', () => {
      expect(() => resolveRefs({ $from: 'ghost' }, lookup({}))).toThrow(/has not run/);
    });

    // `a.b.c` quietly evaluating to undefined is the most common way a data-flow
    // bug reaches production wearing a disguise.
    it('throws for a missing key rather than yielding undefined', () => {
      expect(() =>
        resolveRefs({ $from: 'a', path: 'nope' }, lookup({ a: { x: 1 } })),
      ).toThrow(/has no key "nope"/);
    });

    it('names the step and where it got to', () => {
      expect(() =>
        resolveRefs({ $from: 'a', path: 'x.y.z' }, lookup({ a: { x: { y: {} } } })),
      ).toThrow(/"a"'s result at "x\.y" has no key "z"/);
    });

    it('reports reading through null', () => {
      expect(() =>
        resolveRefs({ $from: 'a', path: 'x.y' }, lookup({ a: { x: null } })),
      ).toThrow(/is null, so "x\.y" cannot be read/);
    });

    it('reports reading a key from a primitive', () => {
      expect(() =>
        resolveRefs({ $from: 'a', path: 'x.y' }, lookup({ a: { x: 5 } })),
      ).toThrow(/is a number, so "y" cannot be read/);
    });

    it('reports a non-index segment against an array', () => {
      expect(() =>
        resolveRefs({ $from: 'a', path: 'items.first' }, lookup({ a: { items: [] } })),
      ).toThrow(/is an array, but "first" is not an index/);
    });

    it('reports an out-of-range index', () => {
      expect(() =>
        resolveRefs({ $from: 'a', path: 'items.5' }, lookup({ a: { items: ['x'] } })),
      ).toThrow(/has 1 item\(s\), so index 5 is out of range/);
    });
  });
});

describe('validateRefs', () => {
  it('accepts a reference to a declared dependency', () => {
    expect(() => {
      validateRefs([
        { name: 'a' },
        { name: 'b', dependsOn: ['a'], input: { x: { $from: 'a' } } },
      ]);
    }).not.toThrow();
  });

  it('accepts a plan with no references at all', () => {
    expect(() => {
      validateRefs([{ name: 'a', input: { plain: 1 } }]);
    }).not.toThrow();
  });

  it('rejects a reference to a step that is not in the plan', () => {
    expect(() => {
      validateRefs([{ name: 'b', input: { x: { $from: 'ghost' } } }]);
    }).toThrow(/no such step is in the plan/);
  });

  // The subtle one. Without dependsOn the kernel may run the two concurrently,
  // and the reference resolves against a result that does not exist yet — a race
  // that passes in tests and fails in production.
  it('rejects a reference that is not a declared dependency', () => {
    expect(() => {
      validateRefs([{ name: 'a' }, { name: 'b', input: { x: { $from: 'a' } } }]);
    }).toThrow(/does not declare it in dependsOn/);
  });

  it('explains why the missing dependency matters', () => {
    expect(() => {
      validateRefs([{ name: 'a' }, { name: 'b', input: { x: { $from: 'a' } } }]);
    }).toThrow(/could run concurrently/);
  });

  it('rejects a step referencing its own result', () => {
    expect(() => {
      validateRefs([{ name: 'a', dependsOn: ['a'], input: { x: { $from: 'a' } } }]);
    }).toThrow(/references its own result/);
  });

  it('checks references nested deep in the input', () => {
    expect(() => {
      validateRefs([{ name: 'b', input: { deep: [{ x: { $from: 'ghost' } }] } }]);
    }).toThrow(/no such step is in the plan/);
  });

  it('checks every step, not just the first', () => {
    expect(() => {
      validateRefs([
        { name: 'a' },
        { name: 'b', dependsOn: ['a'], input: { x: { $from: 'a' } } },
        { name: 'c', input: { x: { $from: 'ghost' } } },
      ]);
    }).toThrow(/ghost/);
  });

  // A transitive dependency is not a declared one. `c` depends on `b` which
  // depends on `a`, so `a` has certainly run by the time `c` does — but saying
  // so out loud is what keeps one graph rather than two.
  it('requires a direct dependency, not a transitive one', () => {
    expect(() => {
      validateRefs([
        { name: 'a' },
        { name: 'b', dependsOn: ['a'] },
        { name: 'c', dependsOn: ['b'], input: { x: { $from: 'a' } } },
      ]);
    }).toThrow(/does not declare it in dependsOn/);
  });
});
