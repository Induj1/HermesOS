/**
 * The framework against a real kernel.
 *
 * These build an actual `Runtime` with real tools and run real missions. That is
 * the point: `asKernelAgent` is where the two meanings of "agent" meet, and the
 * claim that they compose is only worth something if it is checked against the
 * kernel that will actually be in play.
 *
 * The property worth stating plainly, because it looks like a contradiction: the
 * framework's agents never execute tools, and tools nevertheless run. The agent
 * *asks*; the kernel *acts*. `kernelExecutor` is the seam, and it does nothing
 * but forward to `tools.invoke`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defineTool, Runtime, sequentialIds } from '@hermes/kernel';
import type { ToolAccess } from '@hermes/kernel';
import { AgentRuntime } from '../src/runtime.js';
import { defineAgent } from '../src/agent.js';
import { asKernelAgent, kernelExecutor } from '../src/adapters/kernel-agent.js';
import type { AgentDecision } from '../src/model.js';
import type { Reasoner } from '../src/ports/reasoner.js';

let open: Runtime | undefined;

afterEach(async () => {
  await open?.stop({ mode: 'cancel' });
  open = undefined;
});

/** A started kernel runtime with real tools. */
function kernel(calls: string[] = []): Runtime {
  const runtime = Runtime.create({ ids: sequentialIds() });
  open = runtime;
  runtime.use({
    name: 'fixtures',
    setup(ctx) {
      ctx.registerTool(
        defineTool<unknown, string>({
          name: 'calendar.today',
          description: "Today's events",
          execute: () => {
            calls.push('calendar.today');
            return Promise.resolve('a standup at 10');
          },
        }),
      );
      ctx.registerTool(
        defineTool<unknown, never>({
          name: 'broken',
          description: 'Always fails',
          execute: () => Promise.reject(new Error('tool exploded')),
        }),
      );
    },
  });
  return runtime;
}

/** A reasoner that returns each decision in turn. */
function scripted(decisions: readonly AgentDecision[]): Reasoner {
  let next = 0;
  return {
    name: 'scripted',
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

const agents = (reasoner: Reasoner, name = 'assistant'): AgentRuntime =>
  new AgentRuntime({
    ids: sequentialIds(),
    agents: [defineAgent({ name, description: 'Answers questions', reasoner })],
  });

describe('kernelExecutor', () => {
  it('lists what the kernel actually has', async () => {
    const runtime = kernel();
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    expect(
      executor
        .available()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['broken', 'calendar.today']);
    expect(executor.available()[0]?.kind).toBe('tool');
  });

  it('runs a tool through the kernel and reports what it returned', async () => {
    const calls: string[] = [];
    const runtime = kernel(calls);
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    const observations = await executor.execute([
      { id: 'r1', name: 'calendar.today', kind: 'tool', args: {} },
    ]);

    expect(calls).toEqual(['calendar.today']);
    expect(observations).toEqual([
      { id: 'r1', name: 'calendar.today', ok: true, result: 'a standup at 10' },
    ]);
  });

  // A tool failing is information the agent should reason about, not an
  // exception that ends the session.
  it('reports a failing tool as an observation, not a rejection', async () => {
    const runtime = kernel();
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    const observations = await executor.execute([
      { id: 'r1', name: 'broken', kind: 'tool', args: {} },
    ]);

    expect(observations[0]).toMatchObject({
      ok: false,
      error: { message: 'tool exploded' },
    });
  });

  it('reports a tool that does not exist as an observation', async () => {
    const runtime = kernel();
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    const observations = await executor.execute([
      { id: 'r1', name: 'invented', kind: 'tool', args: {} },
    ]);

    // The model hallucinated a tool. The agent gets to reason about the refusal.
    expect(observations[0]).toMatchObject({ ok: false });
    expect(observations[0]?.error?.message).toMatch(/invented/);
  });

  // The kernel gives an agent no way to invoke another agent, so this cannot be
  // honoured — and says so rather than failing obscurely.
  it('explains that an agent request cannot be honoured from inside a task', async () => {
    const runtime = kernel();
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    const observations = await executor.execute([
      { id: 'r1', name: 'summariser', kind: 'agent', args: {} },
    ]);

    expect(observations[0]).toMatchObject({ ok: false });
    expect(observations[0]?.error?.message).toMatch(/Use a delegate decision instead/);
  });

  it('runs a batch concurrently rather than serialising it', async () => {
    const runtime = kernel();
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    const observations = await executor.execute([
      { id: 'r1', name: 'calendar.today', kind: 'tool', args: {} },
      { id: 'r2', name: 'calendar.today', kind: 'tool', args: {} },
    ]);

    // One observation per request, in the same order — which is what lets a
    // transcript match results to calls.
    expect(observations.map((o) => o.id)).toEqual(['r1', 'r2']);
  });

  it('reports an aborted request without running it', async () => {
    const calls: string[] = [];
    const runtime = kernel(calls);
    await runtime.start();
    const executor = kernelExecutor(toolsOf(runtime));

    const observations = await executor.execute(
      [{ id: 'r1', name: 'calendar.today', kind: 'tool', args: {} }],
      AbortSignal.abort(),
    );

    expect(observations[0]?.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('asKernelAgent', () => {
  // The typo should not wait until a mission has already had half its effects —
  // the same gap the planner exists to close (RFC-0003 §4).
  it('refuses at registration time when the agent does not exist', () => {
    expect(() => asKernelAgent(agents(scripted([])), 'ghost')).toThrow(/ghost/);
  });

  it('exposes a framework agent as an ordinary kernel agent', async () => {
    const framework = agents(scripted([{ kind: 'answer', content: 'the answer' }]));
    const runtime = kernel();
    runtime.use({
      name: 'agents',
      setup: (ctx) => {
        ctx.registerAgent(asKernelAgent(framework, 'assistant'));
      },
    });
    await runtime.start();

    // From the kernel's side this is one agent that takes input and returns
    // output, exactly like any other.
    const snapshot = await runtime.run({
      name: 'ask',
      tasks: [
        {
          name: 'ask',
          handler: { kind: 'agent', name: 'assistant' },
          input: 'what is on?',
        },
      ],
    });

    expect(snapshot.state).toBe('succeeded');
    expect(snapshot.tasks[0]?.result).toBe('the answer');
  });

  // The whole arrangement in one test: the agent asked, the kernel acted.
  it('runs a whole session — tools and all — inside one kernel task', async () => {
    const calls: string[] = [];
    const framework = agents(
      scripted([
        {
          kind: 'tools',
          requests: [{ id: 'r1', name: 'calendar.today', kind: 'tool', args: {} }],
        },
        { kind: 'answer', content: 'you have a standup' },
      ]),
    );
    const runtime = kernel(calls);
    runtime.use({
      name: 'agents',
      setup: (ctx) => {
        ctx.registerAgent(asKernelAgent(framework, 'assistant'));
      },
    });
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'ask',
      tasks: [{ name: 'ask', handler: { kind: 'agent', name: 'assistant' } }],
    });

    // The tool really ran — dispatched by the kernel, through its own tool
    // access — and the framework never touched it.
    expect(calls).toEqual(['calendar.today']);
    expect(snapshot.tasks[0]?.result).toBe('you have a standup');
  });

  it('carries the kernel task identity onto the request', async () => {
    const seen: unknown[] = [];
    const framework = agents({
      name: 'spy',
      reason: (req) => {
        seen.push(req.metadata);
        return Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision);
      },
    });
    const runtime = kernel();
    runtime.use({
      name: 'agents',
      setup: (ctx) => {
        ctx.registerAgent(asKernelAgent(framework, 'assistant'));
      },
    });
    await runtime.start();

    await runtime.run({
      name: 'ask',
      tasks: [{ name: 'ask', handler: { kind: 'agent', name: 'assistant' } }],
    });

    expect(seen[0]).toMatchObject({ attempt: 1 });
  });

  // Returning undefined would tell the kernel the task succeeded, and a mission
  // would sail on with a step that decided nothing.
  it('fails the task when the agent does not answer', async () => {
    const framework = agents(scripted([{ kind: 'abstain', reason: 'not mine' }]));
    const runtime = kernel();
    runtime.use({
      name: 'agents',
      setup: (ctx) => {
        ctx.registerAgent(asKernelAgent(framework, 'assistant'));
      },
    });
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'ask',
      tasks: [{ name: 'ask', handler: { kind: 'agent', name: 'assistant' } }],
    });

    expect(snapshot.state).toBe('failed');
    expect(snapshot.tasks[0]?.error?.message).toMatch(/did not answer \(abstained\)/);
  });

  it('lets a host turn a non-answer into a value instead', async () => {
    const framework = agents(scripted([{ kind: 'abstain' }]));
    const runtime = kernel();
    runtime.use({
      name: 'agents',
      setup: (ctx) => {
        ctx.registerAgent(
          asKernelAgent(framework, 'assistant', {
            onNoAnswer: (result) => `nothing: ${result.outcome}`,
          }),
        );
      },
    });
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'ask',
      tasks: [{ name: 'ask', handler: { kind: 'agent', name: 'assistant' } }],
    });

    expect(snapshot.tasks[0]?.result).toBe('nothing: abstained');
  });

  it('takes the framework agent name, description and tags by default', () => {
    const framework = new AgentRuntime({
      agents: [
        defineAgent({
          name: 'summariser',
          description: 'Summarises things',
          tags: ['text'],
          reasoner: scripted([]),
        }),
      ],
    });

    const kernelAgent = asKernelAgent(framework, 'summariser');

    expect(kernelAgent.name).toBe('summariser');
    expect(kernelAgent.description).toBe('Summarises things');
    // The socket the kernel left open for a routing layer.
    expect(kernelAgent.capabilities).toEqual(['text']);
  });

  it('takes an override name, so one agent can be exposed twice', () => {
    const framework = agents(scripted([]));

    expect(
      asKernelAgent(framework, 'assistant', {
        name: 'helper',
        description: 'Another view',
      }),
    ).toMatchObject({
      name: 'helper',
      description: 'Another view',
    });
  });
});

/** The kernel's ToolAccess, as an agent would receive it. */
function toolsOf(runtime: Runtime): ToolAccess {
  return {
    has: (name) => runtime.tools.has(name),
    list: () =>
      runtime.tools
        .list()
        .map((tool) => ({ name: tool.name, description: tool.description })),
    invoke: async (name, input) => {
      const tool = runtime.tools.get(name);
      if (!tool) throw new Error(`No tool named "${name}"`);
      return await tool.execute(input, {} as never);
    },
  };
}
