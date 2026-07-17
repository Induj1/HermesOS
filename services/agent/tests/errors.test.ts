/**
 * Error behaviour, and the defaults nothing else exercises.
 *
 * Not tests of wording — the `code` is the contract (RFC-0001 §5). What is
 * pinned is that each layer's errors stay its own: an agent error that claimed to
 * be a `ModelError` would blame a provider for the framework's fault, in the one
 * place a reader is looking for the right answer.
 */

import { describe, expect, it } from 'vitest';
import { KernelError } from '@hermes/kernel';
import { ModelError } from '@hermes/model';
import { PlannerError } from '@hermes/planner';
import {
  AgentError,
  AgentNotFoundError,
  DelegationLoopError,
  InvalidInputError,
  ReasoningFailedError,
  toError,
  TurnsExhaustedError,
} from '../src/errors.js';
import { AgentRuntime } from '../src/runtime.js';
import { defineAgent } from '../src/agent.js';
import type { AgentDecision } from '../src/model.js';
import { FakeExecutor, fakeMemory, request } from './helpers/fixtures.js';

describe('AgentError', () => {
  it('carries a stable machine-readable code', () => {
    expect(new AgentNotFoundError('a', []).code).toBe('AGENT_NOT_FOUND');
    expect(new ReasoningFailedError('a', []).code).toBe('REASONING_FAILED');
    expect(new TurnsExhaustedError('a', 3).code).toBe('TURNS_EXHAUSTED');
    expect(new DelegationLoopError(['a', 'b', 'a']).code).toBe('DELEGATION_LOOP');
    expect(new InvalidInputError(['bad']).code).toBe('INVALID_INPUT');
  });

  it('names itself after its concrete subclass', () => {
    expect(new InvalidInputError(['bad']).name).toBe('InvalidInputError');
  });

  it('is catchable as an AgentError and as an Error', () => {
    const error = new InvalidInputError(['bad']);

    expect(error).toBeInstanceOf(AgentError);
    expect(error).toBeInstanceOf(Error);
  });

  // Each of these would blame a different layer for this one's fault.
  it('belongs to no other layer', () => {
    const error = new InvalidInputError(['bad']);

    expect(error).not.toBeInstanceOf(KernelError);
    expect(error).not.toBeInstanceOf(PlannerError);
    expect(error).not.toBeInstanceOf(ModelError);
  });
});

describe('AgentNotFoundError', () => {
  it('lists the agents it does have, because a delegation usually invented one', () => {
    const error = new AgentNotFoundError('ghost', ['router', 'summariser']);

    expect(error.agent).toBe('ghost');
    expect(error.message).toContain('Known agents: router, summariser');
  });

  it('says so when nothing is registered at all, which is a different problem', () => {
    expect(new AgentNotFoundError('ghost', []).message).toMatch(
      /no agents are registered at all/,
    );
  });
});

describe('ReasoningFailedError', () => {
  it('carries what every reasoner did', () => {
    const attempts = [
      { reasoner: 'llm', outcome: 'threw' as const, reason: 'model is down' },
      { reasoner: 'rules', outcome: 'abstained' as const, reason: 'no rule matched' },
    ];

    const error = new ReasoningFailedError('assistant', attempts);

    // "Reasoning failed" alone makes a three-reasoner chain undebuggable.
    expect(error.attempts).toEqual(attempts);
    expect(error.message).toContain('llm (threw: model is down)');
    expect(error.message).toContain('rules (abstained: no rule matched)');
  });

  it('names an empty chain as the wiring mistake it is', () => {
    expect(new ReasoningFailedError('a', []).message).toMatch(/empty reasoner chain/);
  });
});

describe('DelegationLoopError', () => {
  it('shows the path, which is the only thing that identifies the pair', () => {
    const error = new DelegationLoopError(['a', 'b', 'a']);

    expect(error.path).toEqual(['a', 'b', 'a']);
    expect(error.message).toContain('a -> b -> a');
  });
});

describe('toError', () => {
  it('passes an Error through, preserving its identity', () => {
    const original = new TypeError('boom');

    expect(toError(original)).toBe(original);
  });

  it('promotes a thrown string', () => {
    expect(toError('just a string').message).toBe('just a string');
  });

  it('wraps anything else without losing it', () => {
    const error = toError({ weird: true });

    expect(error.message).toContain('Non-Error thrown');
    expect(error.cause).toEqual({ weird: true });
  });
});

/** What nothing else covers: the wiring a host gets when it says nothing. */
describe('defaults', () => {
  const answering = defineAgent({
    name: 'a',
    description: 'x',
    reasoner: {
      name: 'r',
      reason: () => Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision),
    },
  });

  it('runs on a real clock and real ids when given neither', async () => {
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      agents: [answering],
    });

    const before = Date.now();
    const result = await runtime.run('a', request());

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.sessionId).toMatch(/^session_/);
  });

  it('mints a distinct session per run', async () => {
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      agents: [answering],
    });

    const first = await runtime.run('a', request());
    const second = await runtime.run('a', request());

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  // Absent when nothing reported any: a deterministic session legitimately
  // reports no cost, and that is different from costing nothing.
  it('reports no usage for a session that called no model', async () => {
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      agents: [answering],
    });

    expect(await runtime.run('a', request())).not.toHaveProperty('usage');
  });

  it('sums usage across the turns that reported it', async () => {
    let turn = 0;
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      agents: [
        defineAgent({
          name: 'a',
          description: 'x',
          reasoner: {
            name: 'r',
            reason: () => {
              turn += 1;
              return Promise.resolve(
                turn === 1
                  ? ({
                      kind: 'tools',
                      requests: [{ id: 'r1', name: 't', kind: 'tool', args: {} }],
                      usage: { promptTokens: 10, completionTokens: 2 },
                    } satisfies AgentDecision)
                  : ({
                      kind: 'answer',
                      content: 'ok',
                      usage: { promptTokens: 20, completionTokens: 5 },
                    } satisfies AgentDecision),
              );
            },
          },
        }),
      ],
    });

    const result = await runtime.run('a', request());

    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 7 });
  });
});

/** The optional wiring a reasoner may be handed. */
describe('what the session puts on the context', () => {
  const spy = (seen: { memory?: unknown; planner?: unknown }) =>
    defineAgent({
      name: 'a',
      description: 'x',
      reasoner: {
        name: 'r',
        reason: (_req, ctx) => {
          seen.memory = ctx.memory;
          seen.planner = ctx.planner;
          return Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision);
        },
      },
    });

  it('omits memory and planner entirely when the host wired neither', async () => {
    const seen: { memory?: unknown; planner?: unknown } = {};
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      agents: [spy(seen)],
    });

    await runtime.run('a', request());

    // Absent, not null. A reasoner that needs one and did not get it should
    // abstain rather than guess.
    expect(seen.memory).toBeUndefined();
    expect(seen.planner).toBeUndefined();
  });

  it('hands over the read-only memory when the host wired it', async () => {
    const seen: { memory?: unknown } = {};
    const memory = fakeMemory(['a fact']);
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      memory,
      agents: [spy(seen)],
    });

    await runtime.run('a', request());

    expect(seen.memory).toBe(memory);
  });

  it('hands over the planner when the host wired it', async () => {
    const seen: { planner?: unknown } = {};
    const planner = { plan: () => Promise.reject(new Error('not used')) };
    const runtime = new AgentRuntime({
      executor: new FakeExecutor(),
      planner,
      agents: [spy(seen)],
    });

    await runtime.run('a', request());

    expect(seen.planner).toBe(planner);
  });
});
