import type { MemoryAdapter } from '@hermes/agent';
import { systemClock } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { toolExecutor } from '../src/executor.js';
import { COORDINATOR, RouterReasoner, buildTeamRuntime, routeTo } from '../src/team.js';
import { answer, ScriptedModel, spyLogger } from './helpers.js';

describe('routeTo', () => {
  it('routes by keyword', () => {
    expect(routeTo('build a snake game')).toBe('coder');
    expect(routeTo('research the latest AI news')).toBe('researcher');
    expect(routeTo('make a plan for my launch')).toBe('planner');
    expect(routeTo('just say hi')).toBeUndefined();
  });
});

describe('RouterReasoner', () => {
  it('delegates on a match and abstains otherwise', async () => {
    const router = new RouterReasoner();
    const ctx = {} as never;
    expect(await router.reason({ input: 'build a site' }, ctx)).toMatchObject({
      kind: 'delegate',
      agent: 'coder',
    });
    expect(await router.reason({ input: 'hello' }, ctx)).toMatchObject({
      kind: 'abstain',
    });
    // Non-string input is stringified before routing.
    expect(await router.reason({ input: { q: 1 } }, ctx)).toMatchObject({
      kind: 'abstain',
    });
  });
});

describe('buildTeamRuntime', () => {
  it('delegates a build request to the coder specialist', async () => {
    const model = new ScriptedModel([answer('built it')]);
    const runtime = buildTeamRuntime({ model, executor: toolExecutor([]) });

    const result = await runtime.run(COORDINATOR, {
      input: 'build a snake game',
      subject: 'A',
    });

    expect(result.outcome).toBe('answered');
    // A delegation turn is recorded before the specialist answers.
    expect(result.turns.some((turn) => turn.decision.kind === 'delegate')).toBe(true);
    expect(result.turns.at(-1)?.agent).toBe('coder');
  });

  it('answers directly when nothing matches a specialist', async () => {
    const model = new ScriptedModel([answer('hi there')]);
    const runtime = buildTeamRuntime({ model, executor: toolExecutor([]) });

    const result = await runtime.run(COORDINATOR, { input: 'hello', subject: 'A' });
    expect(result.outcome).toBe('answered');
    expect(result.turns.every((turn) => turn.decision.kind !== 'delegate')).toBe(true);
  });

  it('wires memory, logger, and clock when provided', async () => {
    const recalls: string[] = [];
    const memory = {
      recall: (subject: string, text: string) => {
        recalls.push(`${subject}:${text}`);
        return Promise.resolve([]);
      },
    } as unknown as MemoryAdapter;

    const runtime = buildTeamRuntime({
      model: new ScriptedModel([answer('done')]),
      executor: toolExecutor([]),
      memory,
      recall: 2,
      logger: spyLogger(),
      clock: systemClock,
    });

    await runtime.run(COORDINATOR, { input: 'research the news', subject: 'chat-9' });
    expect(recalls.some((r) => r.startsWith('chat-9:'))).toBe(true);
  });
});
