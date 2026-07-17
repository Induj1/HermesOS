import { describe, expect, it, vi } from 'vitest';

import { InvalidTransitionError } from '../src/errors.js';
import { StateMachine, type TransitionMap } from '../src/lifecycle.js';

type Light = 'red' | 'green' | 'off';

const TRANSITIONS = {
  red: ['green', 'off'],
  green: ['red', 'off'],
  off: [],
} as const satisfies TransitionMap<Light>;

const machine = (initial: Light = 'red'): StateMachine<Light> =>
  new StateMachine<Light>(initial, TRANSITIONS, { subject: 'light' });

describe('StateMachine', () => {
  it('starts in the initial state', () => {
    expect(machine('green').state).toBe('green');
  });

  it('moves along a declared edge', () => {
    const sm = machine();
    sm.to('green');
    expect(sm.state).toBe('green');
  });

  it('rejects an undeclared edge and does not move', () => {
    const sm = machine('off');
    expect(() => {
      sm.to('green');
    }).toThrow(InvalidTransitionError);
    expect(sm.state).toBe('off');
  });

  it('names the subject and both states in the error', () => {
    const sm = machine('off');
    expect(() => {
      sm.to('green');
    }).toThrow(/light cannot transition from "off" to "green"/);
  });

  it('reports reachability without moving', () => {
    const sm = machine();
    expect(sm.can('green')).toBe(true);
    expect(sm.can('red')).toBe(false);
    expect(sm.state).toBe('red');
  });

  it('treats a state with no outgoing edges as final', () => {
    expect(machine('off').isFinal).toBe(true);
    expect(machine('red').isFinal).toBe(false);
  });

  it('tryTo reports whether it moved instead of throwing', () => {
    const sm = machine();
    expect(sm.tryTo('green')).toBe(true);
    expect(sm.tryTo('green')).toBe(false);
    expect(sm.state).toBe('green');
  });

  it('notifies onTransition with both states, only on accepted moves', () => {
    const onTransition = vi.fn();
    const sm = new StateMachine<Light>('red', TRANSITIONS, { onTransition });

    sm.to('green');
    expect(onTransition).toHaveBeenCalledExactlyOnceWith('red', 'green');

    expect(sm.tryTo('green')).toBe(false);
    expect(onTransition).toHaveBeenCalledTimes(1);
  });
});
