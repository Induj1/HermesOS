/**
 * The step envelope's own contract.
 *
 * `engine.test.ts` proves the envelope works in place. These cover the edges an
 * engine cannot easily reach: input that crossed a boundary and is malformed, and
 * an execution that has gone away while one of its tasks was still in flight.
 *
 * The envelope's `input` validator is the reason these matter. That input came
 * through the kernel, and on a resume it came out of a checkpoint written by an
 * older version of this package. Both are boundaries, and a boundary that trusts
 * its input is not a boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  noopLogger,
  Registry,
  systemClock,
  toMissionId,
  toTaskId,
} from '@hermes/kernel';
import type { AgentContext, AnyAgent } from '@hermes/kernel';
import {
  stepEnvelope,
  STEP_AGENT_NAME,
  type StepEnvelope,
  type StepSink,
} from '../src/compiler/step-envelope.js';
import { InvalidInputError } from '../src/errors.js';

function sink(overrides: Partial<StepSink> = {}): StepSink {
  return {
    results: { has: () => false, get: () => undefined },
    agents: new Registry<AnyAgent>('agent'),
    onStepStart: () => undefined,
    onStepSuccess: () => Promise.resolve(),
    onStepFailure: () => undefined,
    ...overrides,
  };
}

/** An AgentContext with a tool surface a test can watch. */
function agentContext(
  invoke: (name: string, input: unknown) => Promise<unknown>,
): AgentContext {
  return {
    missionId: toMissionId('mission_1'),
    taskId: toTaskId('task_1'),
    taskName: 'a',
    attempt: 1,
    signal: new AbortController().signal,
    logger: noopLogger,
    clock: systemClock,
    tools: { has: () => true, list: () => [], invoke },
  };
}

const envelope: StepEnvelope = {
  executionId: 'exec_1',
  step: 'a',
  capability: { kind: 'tool', name: 'echo' },
};

describe('registration', () => {
  it('registers under a stable default name', () => {
    expect(stepEnvelope(() => sink()).name).toBe(STEP_AGENT_NAME);
    expect(STEP_AGENT_NAME).toBe('hermes.step');
  });

  it('takes an explicit name', () => {
    expect(stepEnvelope(() => sink(), 'custom').name).toBe('custom');
  });

  // So a capability catalog can tell the engine's plumbing from real work.
  it('tags itself as internal', () => {
    expect(stepEnvelope(() => sink()).capabilities).toContain('hermes.internal');
  });
});

describe('input validation', () => {
  const parse = (input: unknown): unknown =>
    stepEnvelope(() => sink()).input?.parse(input);

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['a number', 7],
  ])('rejects %s instead of an object', (_label, input) => {
    expect(() => parse(input)).toThrow(/must be an object/);
  });

  it('rejects a missing execution id', () => {
    expect(() =>
      parse({ step: 'a', capability: { kind: 'tool', name: 'echo' } }),
    ).toThrow(/executionId must be a non-empty string/);
  });

  it('rejects a missing step name', () => {
    expect(() =>
      parse({ executionId: 'e', capability: { kind: 'tool', name: 'echo' } }),
    ).toThrow(/step must be a non-empty string/);
  });

  it('rejects a capability that is not an object', () => {
    expect(() => parse({ executionId: 'e', step: 'a', capability: 'echo' })).toThrow(
      /capability must be an object/,
    );
  });

  it('rejects a capability kind that is neither tool nor agent', () => {
    expect(() =>
      parse({
        executionId: 'e',
        step: 'a',
        capability: { kind: 'spell', name: 'echo' },
      }),
    ).toThrow(/kind must be "tool" or "agent"/);
  });

  it('rejects a capability with no name', () => {
    expect(() =>
      parse({ executionId: 'e', step: 'a', capability: { kind: 'tool', name: '' } }),
    ).toThrow(/capability.name must be a non-empty string/);
  });

  it('reports every problem at once, not just the first', () => {
    expect(() => parse({ capability: {} })).toThrow(/executionId.*step.*kind/s);
  });

  it('accepts a well-formed envelope, keeping input when present', () => {
    expect(parse({ ...envelope, input: { x: 1 } })).toEqual({
      ...envelope,
      input: { x: 1 },
    });
  });

  it('omits input entirely when the envelope has none', () => {
    expect(parse(envelope)).not.toHaveProperty('input');
  });
});

describe('dispatch', () => {
  it('invokes a tool through the kernel own tool access', async () => {
    const invoke = vi.fn().mockResolvedValue('done');
    const agent = stepEnvelope(() => sink());

    const result = await agent.handle(envelope, agentContext(invoke));

    // The kernel's path: its validator, its error wrapping, its logging. Nothing
    // is reimplemented here.
    expect(invoke).toHaveBeenCalledWith('echo', undefined);
    expect(result).toBe('done');
  });

  it('resolves references against the execution results before invoking', async () => {
    const invoke = vi.fn().mockResolvedValue('ok');
    const agent = stepEnvelope(() =>
      sink({ results: { has: (step) => step === 'earlier', get: () => 'threaded' } }),
    );

    await agent.handle(
      { ...envelope, input: { value: { $from: 'earlier' } } },
      agentContext(invoke),
    );

    expect(invoke).toHaveBeenCalledWith('echo', { value: 'threaded' });
  });

  it('reports the step start with the resolved input and the attempt', async () => {
    const onStepStart = vi.fn();
    const agent = stepEnvelope(() => sink({ onStepStart }));

    await agent.handle(
      envelope,
      agentContext(() => Promise.resolve('x')),
    );

    expect(onStepStart).toHaveBeenCalledWith('a', 1, undefined);
  });

  it('records the result, which is what a later $from will read', async () => {
    const onStepSuccess = vi.fn().mockResolvedValue(undefined);
    const agent = stepEnvelope(() => sink({ onStepSuccess }));

    await agent.handle(
      envelope,
      agentContext(() => Promise.resolve('value')),
    );

    expect(onStepSuccess).toHaveBeenCalledWith('a', 'value');
  });

  // The kernel owns retry, the failure policy, and whether the mission lives, and
  // decides all three from whether this throws. Swallowing would tell the kernel
  // a step succeeded that did not happen.
  it('records a failure and rethrows, leaving the decision to the kernel', async () => {
    const onStepFailure = vi.fn();
    const boom = new Error('boom');
    const agent = stepEnvelope(() => sink({ onStepFailure }));

    await expect(
      agent.handle(
        envelope,
        agentContext(() => Promise.reject(boom)),
      ),
    ).rejects.toThrow(boom);
    expect(onStepFailure).toHaveBeenCalledWith('a', boom);
  });

  it('does not record success when the capability threw', async () => {
    const onStepSuccess = vi.fn();
    const agent = stepEnvelope(() => sink({ onStepSuccess }));

    await expect(
      agent.handle(
        envelope,
        agentContext(() => Promise.reject(new Error('boom'))),
      ),
    ).rejects.toThrow();
    expect(onStepSuccess).not.toHaveBeenCalled();
  });
});

describe('dispatching to an agent', () => {
  const agents = (): Registry<AnyAgent> => new Registry<AnyAgent>('agent');
  const agentStep = {
    ...envelope,
    capability: { kind: 'agent' as const, name: 'inner' },
  };

  it('invokes a registered agent, handing it a real context', async () => {
    const registry = agents();
    const handle = vi.fn().mockResolvedValue('agent result');
    registry.register({ name: 'inner', description: 'x', handle });
    const agent = stepEnvelope(() => sink({ agents: registry }));

    const result = await agent.handle(
      agentStep,
      agentContext(() => Promise.resolve(undefined)),
    );

    expect(result).toBe('agent result');
    // The inner agent gets tools, signal, clock and logger — what the kernel
    // would have given it.
    expect(handle.mock.calls[0]?.[1]).toMatchObject({ taskName: 'a', attempt: 1 });
  });

  // The one line of kernel dispatch this duplicates, on purpose rather than by
  // omission: an agent that declared a validator is entitled to it.
  it('applies the agent own input validator, as the kernel does', async () => {
    const registry = agents();
    registry.register({
      name: 'inner',
      description: 'x',
      input: {
        parse: (): never => {
          throw new TypeError('inner says no');
        },
      },
      handle: () => Promise.resolve('never'),
    });
    const agent = stepEnvelope(() => sink({ agents: registry }));

    await expect(
      agent.handle(
        agentStep,
        agentContext(() => Promise.resolve(undefined)),
      ),
    ).rejects.toThrow('inner says no');
  });

  it('fails in the kernel own shape when the agent is not registered', async () => {
    const agent = stepEnvelope(() => sink({ agents: agents() }));

    await expect(
      agent.handle(
        agentStep,
        agentContext(() => Promise.resolve(undefined)),
      ),
    ).rejects.toThrow(/No agent named "inner" is registered/);
  });
});

describe('when the execution has gone', () => {
  // A real case, not a defensive one: a task can outlive its execution if the
  // engine gave up while a step was in flight.
  it('fails the step rather than running it with nowhere to record', async () => {
    const agent = stepEnvelope(() => undefined);

    const promise = agent.handle(
      envelope,
      agentContext(() => Promise.resolve('x')),
    );

    await expect(promise).rejects.toThrow(InvalidInputError);
    await expect(promise).rejects.toThrow(/is not running here/);
  });

  it('does not invoke the capability', async () => {
    const invoke = vi.fn();
    const agent = stepEnvelope(() => undefined);

    await expect(agent.handle(envelope, agentContext(invoke))).rejects.toThrow();

    // Running it would have an effect nobody is waiting for.
    expect(invoke).not.toHaveBeenCalled();
  });
});
