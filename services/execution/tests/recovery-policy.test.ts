/**
 * The recovery decision.
 *
 * Pure, and separated from the engine precisely so it can be tested without a
 * runtime, a plan, or a failure — which is the difference between this being
 * covered and being covered by accident.
 */

import { describe, expect, it, vi } from 'vitest';
import { NO_RECOVERY, shouldRecover } from '../src/recovery/recovery-policy.js';
import type { RecoveryDecision } from '../src/recovery/recovery-policy.js';

const decision = (
  attempt: number,
  overrides: Partial<RecoveryDecision> = {},
): RecoveryDecision => ({
  attempt,
  failures: [{ step: 'a', message: 'boom' }],
  ...overrides,
});

describe('shouldRecover', () => {
  // Recovery re-runs steps, and whether that is safe depends on whether the
  // capabilities are idempotent — which this package cannot know.
  it('is off when no budget is given', () => {
    expect(shouldRecover({ incomplete: 'retry' }, decision(1))).toBe(false);
  });

  it('is off under NO_RECOVERY', () => {
    expect(shouldRecover(NO_RECOVERY, decision(1))).toBe(false);
  });

  it('allows attempts up to the budget', () => {
    const policy = { maxAttempts: 2, incomplete: 'retry' } as const;

    expect(shouldRecover(policy, decision(1))).toBe(true);
    expect(shouldRecover(policy, decision(2))).toBe(true);
  });

  // A replan loop that does not converge is worse than a failure, and each turn
  // costs real money when a model is in the chain.
  it('stops once the budget is spent', () => {
    expect(shouldRecover({ maxAttempts: 2, incomplete: 'retry' }, decision(3))).toBe(
      false,
    );
  });

  it('defaults to recovering when the policy offers no opinion', () => {
    expect(shouldRecover({ maxAttempts: 1, incomplete: 'retry' }, decision(1))).toBe(
      true,
    );
  });

  it('honours a policy that declines this particular failure', () => {
    const policy = {
      maxAttempts: 5,
      incomplete: 'retry' as const,
      shouldRecover: () => false,
    };

    expect(shouldRecover(policy, decision(1))).toBe(false);
  });

  it('shows the policy what failed, so it can tell a blip from a bug', () => {
    const spy = vi.fn().mockReturnValue(true);

    shouldRecover(
      { maxAttempts: 1, incomplete: 'retry', shouldRecover: spy },
      decision(1, {
        failures: [{ step: 'send', message: 'bad input', code: 'INVALID_INPUT' }],
      }),
    );

    expect(spy).toHaveBeenCalledWith({
      attempt: 1,
      failures: [{ step: 'send', message: 'bad input', code: 'INVALID_INPUT' }],
    });
  });

  // The budget is checked first, so an exhausted execution does not keep paying
  // a policy to tell it what the counter already knows.
  it('does not consult the policy once the budget is spent', () => {
    const spy = vi.fn().mockReturnValue(true);

    expect(
      shouldRecover(
        { maxAttempts: 1, incomplete: 'retry', shouldRecover: spy },
        decision(2),
      ),
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
