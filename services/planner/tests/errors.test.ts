/**
 * Error behaviour.
 *
 * These are not tests of wording — the `code` is the contract and the message is
 * explicitly free to change (RFC-0001 §5). What is pinned here is the part
 * callers and humans genuinely depend on: that the code is stable, that the
 * structured payload carries *everything* rather than the first item, and that
 * `toError` never loses what was thrown.
 */

import { describe, expect, it } from 'vitest';
import { KernelError } from '@hermes/kernel';
import {
  InvalidInputError,
  NothingToReplanError,
  PlannerError,
  PlanningFailedError,
  PlanValidationError,
  toError,
} from '../src/errors.js';

describe('PlannerError', () => {
  it('carries a stable machine-readable code', () => {
    expect(new PlanValidationError([]).code).toBe('PLAN_INVALID');
    expect(new PlanningFailedError('goal', []).code).toBe('PLANNING_FAILED');
    expect(new NothingToReplanError('m1', 'done').code).toBe('NOTHING_TO_REPLAN');
    expect(new InvalidInputError(['bad']).code).toBe('INVALID_INPUT');
  });

  it('names itself after its concrete subclass, not the base', () => {
    // `name` is what a stack trace and a log line show.
    expect(new InvalidInputError(['bad']).name).toBe('InvalidInputError');
  });

  it('is catchable as a PlannerError and as an Error', () => {
    const error = new InvalidInputError(['bad']);

    expect(error).toBeInstanceOf(PlannerError);
    expect(error).toBeInstanceOf(Error);
  });

  // A planner error that were `instanceof KernelError` would claim the kernel
  // threw it, and the kernel has never heard of this package.
  it('is not a KernelError, because the kernel did not throw it', () => {
    expect(new InvalidInputError(['bad'])).not.toBeInstanceOf(KernelError);
  });
});

describe('PlanValidationError', () => {
  it('carries every issue, not just the first', () => {
    const issues = [
      { step: 'a', message: 'intent must not be empty' },
      { step: undefined, message: 'plan must have at least one step' },
    ];

    // The author fixing this is now sometimes a model repairing its own output,
    // which makes completeness worth more, not less.
    expect(new PlanValidationError(issues).issues).toEqual(issues);
  });

  it('attributes a step-scoped issue to its step in the message', () => {
    const error = new PlanValidationError([
      { step: 'render', message: 'no such tool' },
    ]);

    expect(error.message).toContain('step "render": no such tool');
  });

  it('states a plan-wide issue without inventing a step to blame', () => {
    const error = new PlanValidationError([
      { step: undefined, message: 'plan is empty' },
    ]);

    expect(error.message).toBe('Invalid plan: plan is empty');
  });
});

describe('PlanningFailedError', () => {
  it('carries the whole chain, so a five-strategy failure is debuggable', () => {
    const attempts = [
      { strategy: 'llm', outcome: 'threw', reason: 'model is down' },
      { strategy: 'template', outcome: 'declined' },
    ];

    const error = new PlanningFailedError('Summarise my day', attempts);

    expect(error.attempts).toEqual(attempts);
    expect(error.message).toContain('llm (threw: model is down)');
    // No reason to report is not the same as an empty reason to report.
    expect(error.message).toContain('template (declined)');
  });

  // Reachable by construction, and it names a wiring mistake rather than a
  // planning one — a different problem with a different fix.
  it('says nothing is registered when the chain was empty', () => {
    expect(new PlanningFailedError('Do it', []).message).toMatch(
      /No strategy is registered/,
    );
  });

  it('truncates a runaway goal statement rather than logging an essay', () => {
    const error = new PlanningFailedError('x'.repeat(500), []);

    expect(error.message).toContain('…');
    expect(error.message.length).toBeLessThan(200);
  });

  it('collapses whitespace in a multi-line goal so the message stays one line', () => {
    const error = new PlanningFailedError('Do\n\n  the   thing', []);

    expect(error.message).toContain('"Do the thing"');
  });

  it('leaves a short goal intact', () => {
    expect(new PlanningFailedError('Do the thing', []).message).toContain(
      '"Do the thing"',
    );
  });
});

describe('NothingToReplanError', () => {
  it('reports the mission it refused and why', () => {
    const error = new NothingToReplanError('mission_7', 'every task already succeeded');

    expect(error.missionId).toBe('mission_7');
    expect(error.message).toBe(
      'Nothing to replan for mission "mission_7": every task already succeeded.',
    );
  });
});

describe('InvalidInputError', () => {
  it('carries every issue it rejected the input for', () => {
    const error = new InvalidInputError([
      'statement must not be empty',
      'maxSteps must be >= 1',
    ]);

    expect(error.issues).toEqual([
      'statement must not be empty',
      'maxSteps must be >= 1',
    ]);
    expect(error.message).toContain(
      'statement must not be empty; maxSteps must be >= 1',
    );
  });
});

describe('toError', () => {
  it('passes an Error through untouched, preserving its identity', () => {
    const original = new TypeError('boom');

    // Identity, not equality: wrapping would lose the stack and the subclass.
    expect(toError(original)).toBe(original);
  });

  it('preserves a PlannerError subclass rather than flattening it', () => {
    const original = new InvalidInputError(['bad']);

    expect(toError(original)).toBe(original);
  });

  it('promotes a thrown string to an Error with that message', () => {
    expect(toError('just a string').message).toBe('just a string');
  });

  // A strategy is not required to be well-behaved. Whatever it throws must
  // survive as something the service can log without crashing on it.
  it.each([
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an object', { code: 500 }, '[object Object]'],
  ])('wraps %s without losing it', (_label, thrown, rendered) => {
    const error = toError(thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Non-Error thrown: ${rendered}`);
    // The original is kept on `cause`, so nothing is actually discarded.
    expect(error.cause).toBe(thrown);
  });
});
