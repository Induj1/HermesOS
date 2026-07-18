import type {
  AgentDecision,
  AgentResult,
  MemoryAdapter,
  SessionOutcome,
} from '@hermes/agent';
import { toSessionId } from '@hermes/agent';
import { systemClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { AGENT_NAME, buildAgentRuntime, replyText } from '../src/agent.js';
import { toolExecutor } from '../src/executor.js';
import { answer, echoTool, ScriptedModel, spyLogger, toolCall } from './helpers.js';

const result = (decision: AgentDecision, outcome: SessionOutcome): AgentResult => ({
  sessionId: toSessionId('session_test'),
  outcome,
  decision,
  turns: [],
  startedAt: 0,
  finishedAt: 1,
});

describe('replyText', () => {
  it('returns a string answer verbatim', () => {
    expect(
      replyText(result({ kind: 'answer', content: 'the answer' }, 'answered')),
    ).toBe('the answer');
  });

  it('serialises a non-string answer', () => {
    expect(replyText(result({ kind: 'answer', content: { a: 1 } }, 'answered'))).toBe(
      '{"a":1}',
    );
  });

  it('uses the abstain reason when present, and a default otherwise', () => {
    expect(
      replyText(result({ kind: 'abstain', reason: 'not my area' }, 'abstained')),
    ).toBe('not my area');
    expect(replyText(result({ kind: 'abstain' }, 'abstained'))).toMatch(
      /don't have an answer/,
    );
  });

  it('explains a plan and a delegation', () => {
    const plan = { kind: 'plan', goal: { objective: 'x' } } as unknown as AgentDecision;
    expect(replyText(result(plan, 'planned'))).toMatch(/plan/);
    expect(replyText(result({ kind: 'delegate', agent: 'other' }, 'answered'))).toMatch(
      /other/,
    );
  });

  it('distinguishes an exhausted tool loop from an unfinished one', () => {
    const tools: AgentDecision = { kind: 'tools', requests: [] };
    expect(replyText(result(tools, 'exhausted'))).toMatch(/step budget/);
    expect(replyText(result(tools, 'answered'))).toMatch(/run some tools/);
  });
});

describe('buildAgentRuntime', () => {
  it('drives a full tool loop end to end and answers', async () => {
    const model = new ScriptedModel([
      toolCall('echo', { text: 'hi' }),
      answer('done: hi'),
    ]);
    const runtime = buildAgentRuntime({
      model,
      executor: toolExecutor([echoTool]),
      maxTurns: 4,
      logger: spyLogger(),
      clock: systemClock,
    });

    const outcome = await runtime.run(AGENT_NAME, { input: 'echo hi' });

    expect(outcome.outcome).toBe('answered');
    expect(replyText(outcome)).toBe('done: hi');
    // The first turn offered tools, because the model advertises tool support.
    expect(model.calls[0]?.withTools).toBe(true);
  });

  it('recalls memories for the subject when a memory adapter is given', async () => {
    const seen: string[] = [];
    const memory = {
      recall: (subject: string, text: string) => {
        seen.push(`${subject}:${text}`);
        return Promise.resolve([]);
      },
    } as unknown as MemoryAdapter;

    const runtime = buildAgentRuntime({
      model: new ScriptedModel([answer('hi')]),
      executor: toolExecutor([]),
      memory,
      recall: 3,
    });

    await runtime.run(AGENT_NAME, { input: 'what is my name?', subject: 'chat-1' });
    expect(seen).toContain('chat-1:what is my name?');
  });
});
