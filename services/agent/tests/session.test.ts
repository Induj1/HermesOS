/**
 * The session loop, and the runtime around it.
 *
 * The claim under test is the subsystem boundary: a session drives
 * decide → execute → observe, and the *executing* leaves through an interface it
 * does not implement. Everything else here — turns, delegation, loop detection,
 * the budget — is what a caller would otherwise write by hand and get wrong.
 */

import { describe, expect, it, vi } from 'vitest';
import { sequentialIds, TestClock } from '@hermes/kernel';
import { AgentRuntime } from '../src/runtime.js';
import { defineAgent } from '../src/agent.js';
import { failedObservation } from '../src/session.js';
import {
  AgentNotFoundError,
  DelegationLoopError,
  InvalidInputError,
  TurnsExhaustedError,
} from '../src/errors.js';
import type { AgentDecision } from '../src/model.js';
import type { Reasoner } from '../src/ports/reasoner.js';
import { NamedTools, NoTools } from '../src/tool-selection.js';
import {
  capability,
  FakeExecutor,
  FIXED_NOW,
  recordingLogger,
  request,
} from './helpers/fixtures.js';

/** A reasoner that returns each decision in turn, one per call. */
function scripted(name: string, decisions: readonly AgentDecision[]): Reasoner {
  let next = 0;
  return {
    name,
    reason: () => {
      // Repeats the last decision once the script runs out, so a test that only
      // cares about the first turn need not spell out the rest.
      const decision = decisions[next] ?? decisions.at(-1);
      next += 1;
      if (!decision) throw new Error('scripted reasoner has no decisions');
      return Promise.resolve(decision);
    },
  };
}

const agentWith = (name: string, decisions: readonly AgentDecision[], overrides = {}) =>
  defineAgent({
    name,
    description: `The ${name} agent`,
    reasoner: scripted(name, decisions),
    ...overrides,
  });

function runtimeWith(
  agents: readonly ReturnType<typeof defineAgent>[],
  options: {
    executor?: FakeExecutor;
    maxTurns?: number;
    throwOnExhausted?: boolean;
    logger?: ReturnType<typeof recordingLogger>['logger'];
  } = {},
): { runtime: AgentRuntime; executor: FakeExecutor } {
  const executor = options.executor ?? new FakeExecutor();
  const runtime = new AgentRuntime({
    executor,
    agents,
    clock: new TestClock(FIXED_NOW),
    ids: sequentialIds(),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.throwOnExhausted === undefined
      ? {}
      : { throwOnExhausted: options.throwOnExhausted }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { runtime, executor };
}

describe('answering', () => {
  it('returns the answer and the transcript', async () => {
    const { runtime } = runtimeWith([
      agentWith('a', [{ kind: 'answer', content: 'done' }]),
    ]);

    const result = await runtime.run('a', request());

    expect(result.outcome).toBe('answered');
    expect(result.decision).toMatchObject({ kind: 'answer', content: 'done' });
    expect(result.turns).toHaveLength(1);
  });

  // An agent that abstained behaved correctly and said so. Making a caller
  // `catch` that would put a normal outcome on the exception path and discard
  // the transcript that explains it.
  it('resolves rather than throwing when the agent abstains', async () => {
    const { runtime } = runtimeWith([
      agentWith('a', [{ kind: 'abstain', reason: 'not mine' }]),
    ]);

    const result = await runtime.run('a', request());

    expect(result.outcome).toBe('abstained');
  });

  it('reports a plan decision as planned, and stops there', async () => {
    const goal = { statement: 'summarise my day' };
    const { runtime } = runtimeWith([agentWith('a', [{ kind: 'plan', goal }])]);

    const result = await runtime.run('a', request());

    expect(result.outcome).toBe('planned');
    expect(result.decision).toMatchObject({ kind: 'plan', goal });
  });

  it('times the session with the injected clock', async () => {
    const { runtime } = runtimeWith([
      agentWith('a', [{ kind: 'answer', content: 'x' }]),
    ]);

    const result = await runtime.run('a', request());

    expect(result.startedAt).toBe(FIXED_NOW);
    expect(result.finishedAt).toBe(FIXED_NOW);
  });
});

describe('the tool loop', () => {
  const toolsThenAnswer: readonly AgentDecision[] = [
    {
      kind: 'tools',
      requests: [{ id: 'r1', name: 'search', kind: 'tool', args: { q: 'x' } }],
    },
    { kind: 'answer', content: 'found it' },
  ];

  it('runs the tools, then asks again, then answers', async () => {
    const { runtime, executor } = runtimeWith([agentWith('a', toolsThenAnswer)]);

    const result = await runtime.run('a', request());

    expect(executor.batches).toEqual([
      [{ id: 'r1', name: 'search', kind: 'tool', args: { q: 'x' } }],
    ]);
    expect(result.outcome).toBe('answered');
    expect(result.turns).toHaveLength(2);
  });

  it('puts the observations on the turn that asked for them', async () => {
    const executor = new FakeExecutor({ results: { search: 'a standup' } });
    const { runtime } = runtimeWith([agentWith('a', toolsThenAnswer)], { executor });

    const result = await runtime.run('a', request());

    expect(result.turns[0]?.observations).toEqual([
      { id: 'r1', name: 'search', ok: true, result: 'a standup' },
    ]);
  });

  // A reasoner is stateless between turns; `history` is its memory of the last.
  it('shows the next decision what the tools returned', async () => {
    const seen: number[] = [];
    const agent = defineAgent({
      name: 'a',
      description: 'x',
      reasoner: {
        name: 'r',
        reason: (_req, ctx) => {
          seen.push(ctx.history.length);
          return Promise.resolve(
            ctx.history.length === 0
              ? ({
                  kind: 'tools',
                  requests: [{ id: 'r1', name: 'search', kind: 'tool', args: {} }],
                } satisfies AgentDecision)
              : ({
                  kind: 'answer',
                  content: ctx.history[0]?.observations?.[0]?.result,
                } satisfies AgentDecision),
          );
        },
      },
    });
    const { runtime } = runtimeWith([agent], {
      executor: new FakeExecutor({ results: { search: 'the result' } }),
    });

    const result = await runtime.run('a', request());

    expect(seen).toEqual([0, 1]);
    expect(result.decision).toMatchObject({ content: 'the result' });
  });

  // The port promises the whole batch precisely so independent lookups can run
  // together; a session that looped would serialise work.
  it('hands the executor the whole batch at once', async () => {
    const { runtime, executor } = runtimeWith([
      agentWith('a', [
        {
          kind: 'tools',
          requests: [
            { id: 'r1', name: 'search', kind: 'tool', args: {} },
            { id: 'r2', name: 'lookup', kind: 'tool', args: {} },
          ],
        },
        { kind: 'answer', content: 'done' },
      ]),
    ]);

    await runtime.run('a', request());

    expect(executor.batches).toHaveLength(1);
    expect(executor.batches[0]).toHaveLength(2);
  });

  // A tool failing is information the agent should reason about, not an
  // exception that ends the session.
  it('carries a tool failure back to the agent rather than throwing', async () => {
    const executor = new FakeExecutor({ failures: { search: 'timed out' } });
    const { runtime } = runtimeWith([agentWith('a', toolsThenAnswer)], { executor });

    const result = await runtime.run('a', request());

    expect(result.outcome).toBe('answered');
    expect(result.turns[0]?.observations?.[0]).toMatchObject({
      ok: false,
      error: { message: 'timed out' },
    });
  });
});

describe('the turn budget', () => {
  const loops: readonly AgentDecision[] = [
    { kind: 'tools', requests: [{ id: 'r1', name: 'search', kind: 'tool', args: {} }] },
  ];

  // A model that asks for a tool, reads it, and asks for the same tool again will
  // do that forever, and each turn is a model call somebody pays for.
  it('stops an agent that loops, and says it never concluded', async () => {
    const { runtime, executor } = runtimeWith([agentWith('a', loops)], { maxTurns: 3 });

    const result = await runtime.run('a', request());

    expect(result.outcome).toBe('exhausted');
    expect(executor.batches).toHaveLength(3);
  });

  // The last decision was necessarily a `tools` one; reporting that as the
  // outcome would claim the agent decided something final when it was mid-thought.
  it('reports an abstain rather than claiming the half-finished decision', async () => {
    const { runtime } = runtimeWith([agentWith('a', loops)], { maxTurns: 2 });

    const result = await runtime.run('a', request());

    expect(result.decision.kind).toBe('abstain');
    if (result.decision.kind !== 'abstain') throw new Error('expected an abstain');
    expect(result.decision.reason).toContain('2 turns');
  });

  // The transcript is the evidence. Throwing it away to raise an exception
  // discards exactly what the operator needs.
  it('keeps the transcript, which is the point of not throwing', async () => {
    const { runtime } = runtimeWith([agentWith('a', loops)], { maxTurns: 3 });

    const result = await runtime.run('a', request());

    expect(result.turns).toHaveLength(3);
  });

  it('throws instead, for a host that asked for that', async () => {
    const { runtime } = runtimeWith([agentWith('a', loops)], {
      maxTurns: 2,
      throwOnExhausted: true,
    });

    await expect(runtime.run('a', request())).rejects.toThrow(TurnsExhaustedError);
  });

  it('warns when the budget runs out', async () => {
    const { logger, messages } = recordingLogger();
    const { runtime } = runtimeWith([agentWith('a', loops)], { maxTurns: 1, logger });

    await runtime.run('a', request());

    expect(messages).toContainEqual({
      level: 'warn',
      message: 'Agent did not reach an answer within its turn budget',
    });
  });
});

describe('delegation', () => {
  it('hands the request to the named agent', async () => {
    const { runtime } = runtimeWith([
      agentWith('router', [{ kind: 'delegate', agent: 'specialist' }]),
      agentWith('specialist', [{ kind: 'answer', content: 'specialist answered' }]),
    ]);

    const result = await runtime.run('router', request());

    expect(result.decision).toMatchObject({ content: 'specialist answered' });
    expect(result.turns.map((t) => t.agent)).toEqual(['router', 'specialist']);
  });

  it('lets the delegating agent rewrite the request', async () => {
    const seen: unknown[] = [];
    const specialist = defineAgent({
      name: 'specialist',
      description: 'x',
      reasoner: {
        name: 'r',
        reason: (req) => {
          seen.push(req.input);
          return Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision);
        },
      },
    });
    const { runtime } = runtimeWith([
      agentWith('router', [
        { kind: 'delegate', agent: 'specialist', request: { input: 'rewritten' } },
      ]),
      specialist,
    ]);

    await runtime.run('router', request('original'));

    expect(seen).toEqual(['rewritten']);
  });

  // Almost always a model inventing a plausible colleague.
  it('names the agents it does have when a delegation misses', async () => {
    const { runtime } = runtimeWith([
      agentWith('router', [{ kind: 'delegate', agent: 'ghost' }]),
    ]);

    const promise = runtime.run('router', request());

    await expect(promise).rejects.toThrow(AgentNotFoundError);
    await expect(promise).rejects.toThrow(/Known agents: router/);
  });

  // Two agents each thinking the other should handle this is a configuration
  // fault, and the path is the only thing that identifies it.
  it('refuses a direct circle', async () => {
    const { runtime } = runtimeWith([
      agentWith('a', [{ kind: 'delegate', agent: 'b' }]),
      agentWith('b', [{ kind: 'delegate', agent: 'a' }]),
    ]);

    await expect(runtime.run('a', request())).rejects.toThrow(DelegationLoopError);
    await expect(runtime.run('a', request())).rejects.toThrow(/a -> b -> a/);
  });

  it('refuses a longer circle, which the narrow check would miss', async () => {
    const { runtime } = runtimeWith([
      agentWith('a', [{ kind: 'delegate', agent: 'b' }]),
      agentWith('b', [{ kind: 'delegate', agent: 'c' }]),
      agentWith('c', [{ kind: 'delegate', agent: 'a' }]),
    ]);

    await expect(runtime.run('a', request())).rejects.toThrow(/a -> b -> c -> a/);
  });
});

describe('what a reasoner is shown', () => {
  const spyAgent = (
    name: string,
    seen: { capabilities?: readonly unknown[] },
    overrides = {},
  ) =>
    defineAgent({
      name,
      description: 'x',
      reasoner: {
        name: 'r',
        reason: (_req, ctx) => {
          seen.capabilities = ctx.capabilities;
          return Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision);
        },
      },
      ...overrides,
    });

  it('offers everything by default', async () => {
    const seen: { capabilities?: readonly unknown[] } = {};
    const executor = new FakeExecutor({
      capabilities: [capability('a'), capability('b')],
    });
    const { runtime } = runtimeWith([spyAgent('agent', seen)], { executor });

    await runtime.run('agent', request());

    expect(seen.capabilities).toHaveLength(2);
  });

  // A model that cannot see a tool cannot be talked into asking for it.
  it('offers nothing to an agent that declared NoTools', async () => {
    const seen: { capabilities?: readonly unknown[] } = {};
    const executor = new FakeExecutor({ capabilities: [capability('a')] });
    const { runtime } = runtimeWith(
      [spyAgent('agent', seen, { tools: new NoTools() })],
      {
        executor,
      },
    );

    await runtime.run('agent', request());

    expect(seen.capabilities).toEqual([]);
  });

  it('offers only what the agent declared', async () => {
    const seen: { capabilities?: readonly unknown[] } = {};
    const executor = new FakeExecutor({
      capabilities: [
        capability('calendar.today', { tags: ['calendar'] }),
        capability('payment.send'),
      ],
    });
    const { runtime } = runtimeWith(
      [spyAgent('agent', seen, { tools: new NamedTools({ tags: ['calendar'] }) })],
      { executor },
    );

    await runtime.run('agent', request());

    // A summariser has no business seeing the payment tools.
    expect(seen.capabilities).toEqual([
      expect.objectContaining({ name: 'calendar.today' }),
    ]);
  });
});

describe('AgentRuntime', () => {
  it('refuses an agent with no name or no description', () => {
    const { runtime } = runtimeWith([]);

    expect(() =>
      runtime.register({ name: '  ', description: 'x', reasoner: scripted('r', []) }),
    ).toThrow(InvalidInputError);
    // An agent that cannot describe itself can only ever be reached by name.
    expect(() =>
      runtime.register({ name: 'a', description: ' ', reasoner: scripted('r', []) }),
    ).toThrow(/non-empty description/);
  });

  // The kernel's registry rule: a duplicate is a conflict the host must resolve
  // explicitly, not a race decided by load order.
  it('refuses two agents with one name', () => {
    const { runtime } = runtimeWith([agentWith('a', [])]);

    expect(() => runtime.register(agentWith('a', []))).toThrow(/already registered/i);
  });

  it('reports what a caller could ask for', async () => {
    const { runtime } = runtimeWith([
      agentWith('summariser', [], { tags: ['text'] }),
      agentWith('router', []),
    ]);

    expect(runtime.capabilities()).toEqual([
      { name: 'summariser', description: 'The summariser agent', tags: ['text'] },
      { name: 'router', description: 'The router agent', tags: [] },
    ]);
    await Promise.resolve();
  });

  it('reports an agent that does not exist', async () => {
    const { runtime } = runtimeWith([]);

    await expect(runtime.run('ghost', request())).rejects.toThrow(
      /no agents are registered at all/,
    );
  });

  it('registers agents after construction', async () => {
    const { runtime } = runtimeWith([]);

    runtime.register(agentWith('late', [{ kind: 'answer', content: 'ok' }]));

    expect((await runtime.run('late', request())).outcome).toBe('answered');
  });

  // An executor is a property of *where a session runs*, not of the runtime: the
  // same agent reached through asKernelAgent must use that task's ToolAccess.
  it('takes an executor per session, overriding the default', async () => {
    const perSession = new FakeExecutor({ capabilities: [capability('special')] });
    const { runtime } = runtimeWith([
      agentWith('a', [{ kind: 'answer', content: 'ok' }]),
    ]);

    const session = runtime.session(perSession);

    expect((await session.run('a', request())).outcome).toBe('answered');
  });

  it('refuses a session with no executor from either source', () => {
    const runtime = new AgentRuntime({ agents: [agentWith('a', [])] });

    // At session creation, naming the gap — rather than at the first tool
    // request with a message about `undefined`.
    expect(() => runtime.session()).toThrow(InvalidInputError);
    expect(() => runtime.session()).toThrow(/no executor/);
  });

  it('holds no state between sessions', async () => {
    const { runtime } = runtimeWith([
      agentWith('a', [
        {
          kind: 'tools',
          requests: [{ id: 'r1', name: 'search', kind: 'tool', args: {} }],
        },
        { kind: 'answer', content: 'done' },
      ]),
    ]);

    const first = await runtime.run('a', request());
    const second = await runtime.run('a', request());

    // Two concurrent calls cannot see each other's turns: there is no shared
    // mutable state, so there is nothing to lock.
    expect(first.sessionId).not.toBe(second.sessionId);
  });
});

describe('cancellation', () => {
  it('stops before deciding when already aborted', async () => {
    const reason = vi.fn();
    const { runtime } = runtimeWith([
      defineAgent({ name: 'a', description: 'x', reasoner: { name: 'r', reason } }),
    ]);

    await expect(
      runtime.run('a', request(), { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(reason).not.toHaveBeenCalled();
  });
});

describe('failedObservation', () => {
  it('shapes a failure the way the port promises', () => {
    const observation = failedObservation(
      { id: 'r1', name: 'search' },
      new Error('boom'),
    );

    expect(observation).toEqual({
      id: 'r1',
      name: 'search',
      ok: false,
      error: { message: 'boom' },
    });
  });

  it('keeps a stable error code, which is what callers branch on', () => {
    const error = Object.assign(new Error('nope'), { code: 'NOT_FOUND' });

    expect(failedObservation({ id: 'r1', name: 'x' }, error).error).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('flattens a non-Error throw', () => {
    expect(failedObservation({ id: 'r1', name: 'x' }, 'a string').error?.message).toBe(
      'a string',
    );
  });

  it('omits a code that is not a string', () => {
    const error = Object.assign(new Error('nope'), { code: 500 });

    expect(failedObservation({ id: 'r1', name: 'x' }, error).error).not.toHaveProperty(
      'code',
    );
  });
});
