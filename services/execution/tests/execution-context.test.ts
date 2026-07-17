/**
 * Execution context behaviour.
 *
 * The class is small, and one of its methods carries most of the risk in the
 * package: `has()` decides whether a reference may read a step's result, and
 * getting it wrong means handing a capability a value nobody produced. Most of
 * what follows is about that.
 */

import { describe, expect, it } from 'vitest';
import { TestClock } from '@hermes/kernel';
import { ExecutionContext } from '../src/context/execution-context.js';
import { FIXED_NOW } from './helpers/fixtures.js';

const declaration = [
  { name: 'a', intent: 'Do a', capability: { kind: 'tool', name: 'echo' } as const },
  { name: 'b', intent: 'Do b', capability: { kind: 'agent', name: 'sum' } as const },
];

function context(): ExecutionContext {
  const ctx = new ExecutionContext(new TestClock(FIXED_NOW));
  ctx.declare(declaration);
  return ctx;
}

describe('declare', () => {
  it('seeds every declared step as pending', () => {
    expect(
      context()
        .snapshot()
        .map((step) => [step.name, step.state]),
    ).toEqual([
      ['a', 'pending'],
      ['b', 'pending'],
    ]);
  });

  // On resume the plan is re-declared over a context that already holds results.
  // Overwriting them would throw away the work the checkpoint existed to keep.
  it('never clobbers a step that already has a result', () => {
    const ctx = context();
    ctx.succeeded('a', 'precious');

    ctx.declare(declaration);

    expect(ctx.get('a')).toBe('precious');
  });
});

describe('has', () => {
  it('is true only for a step that succeeded', () => {
    const ctx = context();
    expect(ctx.has('a')).toBe(false);

    ctx.succeeded('a', 1);

    expect(ctx.has('a')).toBe(true);
  });

  // Both must be "no", or a reference substitutes undefined for a value that was
  // never produced. This is the single most important behaviour in the class.
  it.each([
    [
      'a running step',
      (ctx: ExecutionContext) => {
        ctx.started('a', 1);
      },
    ],
    [
      'a failed step',
      (ctx: ExecutionContext) => {
        ctx.failed('a', { name: 'E', message: 'x' });
      },
    ],
    [
      'a skipped step',
      (ctx: ExecutionContext) => {
        ctx.skipped('a');
      },
    ],
  ])('is false for %s', (_label, arrange) => {
    const ctx = context();
    arrange(ctx);

    expect(ctx.has('a')).toBe(false);
    expect(ctx.get('a')).toBeUndefined();
  });

  it('is false for a step nobody declared', () => {
    expect(context().has('ghost')).toBe(false);
  });

  // A void capability still succeeded. Conflating "returned undefined" with "did
  // not run" would make a void tool impossible to depend on.
  it('is true for a step that succeeded with an undefined result', () => {
    const ctx = context();
    ctx.succeeded('a', undefined);

    expect(ctx.has('a')).toBe(true);
    expect(ctx.get('a')).toBeUndefined();
  });
});

describe('recording', () => {
  it('records the attempt and the start time', () => {
    const ctx = context();
    ctx.started('a', 1);

    expect(ctx.record('a')).toMatchObject({
      state: 'running',
      attempts: 1,
      startedAt: FIXED_NOW,
    });
  });

  // A step that retried four times should not look like it started when it last
  // retried — that hides exactly the delay worth seeing.
  it('keeps the original start time across retries', async () => {
    const clock = new TestClock(FIXED_NOW);
    const ctx = new ExecutionContext(clock);
    ctx.declare(declaration);

    ctx.started('a', 1);
    await clock.advance(5_000);
    ctx.started('a', 2);

    expect(ctx.record('a')?.startedAt).toBe(FIXED_NOW);
    expect(ctx.record('a')?.attempts).toBe(2);
  });

  it('clears an earlier error when the step later succeeds', () => {
    const ctx = context();
    ctx.failed('a', { name: 'Error', message: 'first try' });

    ctx.succeeded('a', 'worked');

    expect(ctx.record('a')?.error).toBeUndefined();
    expect(ctx.record('a')?.state).toBe('succeeded');
  });

  it('ignores a step that was never declared rather than throwing', () => {
    const ctx = context();

    // Throwing from an event listener would take down persistence for something
    // that is at worst cosmetic.
    expect(() => {
      ctx.succeeded('ghost', 1);
    }).not.toThrow();
    expect(ctx.record('ghost')).toBeUndefined();
  });
});

describe('reset', () => {
  it('returns a failed step to pending for another attempt', () => {
    const ctx = context();
    ctx.failed('a', { name: 'Error', message: 'boom' });

    ctx.reset('a');

    expect(ctx.record('a')).toMatchObject({ state: 'pending' });
    expect(ctx.record('a')?.error).toBeUndefined();
    expect(ctx.record('a')?.finishedAt).toBeUndefined();
  });

  // The count is what tells an operator this step has now failed four times.
  it('keeps the attempt count, which is the signal worth seeing', () => {
    const ctx = context();
    ctx.started('a', 3);
    ctx.failed('a', { name: 'Error', message: 'boom' });

    ctx.reset('a');

    expect(ctx.record('a')?.attempts).toBe(3);
  });
});

describe('settled', () => {
  it('is false while any step is outstanding', () => {
    const ctx = context();
    ctx.succeeded('a', 1);

    expect(ctx.settled).toBe(false);
  });

  it.each([
    [
      'succeeded',
      (ctx: ExecutionContext) => {
        ctx.succeeded('b', 1);
      },
    ],
    [
      'failed',
      (ctx: ExecutionContext) => {
        ctx.failed('b', { name: 'E', message: 'x' });
      },
    ],
    [
      'skipped',
      (ctx: ExecutionContext) => {
        ctx.skipped('b');
      },
    ],
  ])('is true when the last step is %s', (_label, finish) => {
    const ctx = context();
    ctx.succeeded('a', 1);
    finish(ctx);

    expect(ctx.settled).toBe(true);
  });
});

describe('inState', () => {
  it('selects steps by state, in declaration order', () => {
    const ctx = context();
    ctx.succeeded('a', 1);

    expect(ctx.inState('succeeded').map((step) => step.name)).toEqual(['a']);
    expect(ctx.inState('pending').map((step) => step.name)).toEqual(['b']);
    expect(ctx.inState('succeeded', 'pending')).toHaveLength(2);
  });
});

describe('restore', () => {
  // The crash-recovery path: a process that never saw the execution start picks
  // it up with every earlier result still resolvable.
  it('rebuilds a context in which earlier results still resolve', () => {
    const original = context();
    original.succeeded('a', { kept: true });

    const restored = ExecutionContext.restore(
      new TestClock(FIXED_NOW),
      original.checkpointSteps(),
    );

    expect(restored.has('a')).toBe(true);
    expect(restored.get('a')).toEqual({ kept: true });
    expect(restored.record('b')?.state).toBe('pending');
  });
});

describe('snapshot', () => {
  it('hands out a copy the caller cannot use to reach the state', () => {
    const ctx = context();
    const first = ctx.snapshot();

    ctx.succeeded('a', 1);

    expect(first[0]?.state).toBe('pending');
    expect(ctx.snapshot()[0]?.state).toBe('succeeded');
  });
});
