/**
 * Error behaviour.
 *
 * Not tests of wording — the `code` is the contract and the message is free to
 * change (RFC-0001 §5). What is pinned is what callers depend on: a stable code,
 * a structured payload carrying everything rather than the first item, and
 * `toStepError` never losing what was thrown.
 */

import { describe, expect, it } from 'vitest';
import { KernelError } from '@hermes/kernel';
import { PlannerError } from '@hermes/planner';
import {
  CheckpointCorruptError,
  ExecutionError,
  ExecutionFailedError,
  ExecutionNotFoundError,
  ExecutionStateError,
  InvalidInputError,
  InvalidReferenceError,
  RecoveryExhaustedError,
  toError,
  toStepError,
} from '../src/errors.js';

describe('ExecutionError', () => {
  it('carries a stable machine-readable code', () => {
    expect(new InvalidReferenceError('a', 'why').code).toBe('INVALID_REFERENCE');
    expect(new ExecutionFailedError('e1', []).code).toBe('EXECUTION_FAILED');
    expect(new ExecutionNotFoundError('e1').code).toBe('EXECUTION_NOT_FOUND');
    expect(new ExecutionStateError('e1', 'running', 'resume').code).toBe(
      'EXECUTION_STATE',
    );
    expect(new CheckpointCorruptError('e1', 'why').code).toBe('CHECKPOINT_CORRUPT');
    expect(new RecoveryExhaustedError('e1', 3, 'why').code).toBe('RECOVERY_EXHAUSTED');
    expect(new InvalidInputError(['bad']).code).toBe('INVALID_INPUT');
  });

  it('names itself after its concrete subclass, not the base', () => {
    expect(new InvalidInputError(['bad']).name).toBe('InvalidInputError');
  });

  it('is catchable as an ExecutionError and as an Error', () => {
    const error = new InvalidInputError(['bad']);

    expect(error).toBeInstanceOf(ExecutionError);
    expect(error).toBeInstanceOf(Error);
  });

  // An execution error that claimed to be a kernel or planner error would name
  // the wrong thrower, and neither package has heard of this one.
  it('is neither a KernelError nor a PlannerError', () => {
    const error = new InvalidInputError(['bad']);

    expect(error).not.toBeInstanceOf(KernelError);
    expect(error).not.toBeInstanceOf(PlannerError);
  });
});

describe('InvalidReferenceError', () => {
  it('names the referenced step, without which the message is unactionable', () => {
    const error = new InvalidReferenceError('fetch', 'it has no result');

    expect(error.step).toBe('fetch');
    expect(error.message).toBe(
      'Cannot resolve reference to step "fetch": it has no result.',
    );
  });
});

describe('ExecutionFailedError', () => {
  it('carries every failure, not just the first', () => {
    // Under a `continue` policy several steps fail independently, and reporting
    // one would hide the rest.
    const failures = [
      { step: 'a', error: { name: 'Error', message: 'first' } },
      { step: 'b', error: { name: 'Error', message: 'second' } },
    ];

    const error = new ExecutionFailedError('e1', failures);

    expect(error.failures).toEqual(failures);
    expect(error.message).toContain('a (first)');
    expect(error.message).toContain('b (second)');
  });

  // Reachable: a mission cancelled underneath the engine settles with no step
  // failure recorded, and "failed at 0 steps" would send the reader nowhere.
  it('explains a failure with no failed step', () => {
    expect(new ExecutionFailedError('e1', []).message).toMatch(
      /cancelled or the runtime stopped/,
    );
  });
});

describe('RecoveryExhaustedError', () => {
  it('reports the attempt count, so a low limit reads differently from a dead end', () => {
    const error = new RecoveryExhaustedError('e1', 3, 'nothing left to replan');

    expect(error.attempts).toBe(3);
    expect(error.message).toContain('after 3 attempt(s)');
  });
});

describe('ExecutionStateError', () => {
  it('names both the state and what was attempted', () => {
    const error = new ExecutionStateError('e1', 'succeeded', 'resume');

    expect(error.state).toBe('succeeded');
    expect(error.message).toBe('Cannot resume execution "e1": it is succeeded.');
  });
});

describe('toError', () => {
  it('passes an Error through, preserving its identity', () => {
    const original = new TypeError('boom');

    expect(toError(original)).toBe(original);
  });

  it('promotes a thrown string', () => {
    expect(toError('a string').message).toBe('a string');
  });

  it('wraps anything else without losing it', () => {
    const error = toError({ weird: true });

    expect(error.message).toContain('Non-Error thrown');
    expect(error.cause).toEqual({ weird: true });
  });
});

describe('toStepError', () => {
  // JSON.stringify(new Error('boom')) is '{}', so a checkpoint holding the raw
  // error would record that every failure had no cause.
  it('captures what JSON.stringify silently drops', () => {
    expect(JSON.stringify(new Error('boom'))).toBe('{}');

    const flat = toStepError(new Error('boom'));

    expect(flat.name).toBe('Error');
    expect(flat.message).toBe('boom');
    expect(flat.stack).toContain('boom');
  });

  it('survives a JSON round-trip, which is the whole requirement', () => {
    const flat = toStepError(new Error('boom'));

    expect(JSON.parse(JSON.stringify(flat))).toEqual(flat);
  });

  // The field most worth surviving a message rewording (RFC-0001 §5).
  it('keeps a kernel error code', () => {
    const flat = toStepError(
      Object.assign(new Error('nope'), { code: 'TASK_TIMEOUT' }),
    );

    expect(flat.code).toBe('TASK_TIMEOUT');
  });

  it('omits a code that is not a string rather than carrying nonsense', () => {
    const flat = toStepError(Object.assign(new Error('nope'), { code: 500 }));

    expect(flat).not.toHaveProperty('code');
  });

  it('flattens a non-Error throw', () => {
    expect(toStepError('just a string').message).toBe('just a string');
  });

  it('keeps a subclass name, which is what a reader recognises', () => {
    expect(toStepError(new TypeError('bad')).name).toBe('TypeError');
  });
});
