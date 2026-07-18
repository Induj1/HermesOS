import type { Handler, MessageContext } from '@hermes/telegram';
import { describe, expect, it } from 'vitest';
import { buildAgentRuntime } from '../src/agent.js';
import { handleMessage, registerHandlers, type CommandBot } from '../src/bot.js';
import { toolExecutor } from '../src/executor.js';
import { answer, BrokenModel, ScriptedModel, spyLogger } from './helpers.js';

/** A message context that records what was replied. */
function fakeContext(text: string): { ctx: MessageContext; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    text,
    command: undefined,
    args: [],
    message: { chat: { id: 42 } },
    reply: (message: string) => {
      replies.push(message);
      return Promise.resolve(undefined);
    },
  } as unknown as MessageContext;
  return { ctx, replies };
}

const runtimeWith = (...responses: Parameters<typeof answer>[0][]) =>
  buildAgentRuntime({
    model: new ScriptedModel(responses.map((content) => answer(content))),
    executor: toolExecutor([]),
  });

describe('handleMessage', () => {
  it('prompts for input when the message is blank', async () => {
    const { ctx, replies } = fakeContext('   ');
    await handleMessage(ctx, { runtime: runtimeWith('unused') });

    expect(replies[0]).toMatch(/Send me a task/);
  });

  it('runs the agent and replies with its answer', async () => {
    const { ctx, replies } = fakeContext('what is 2+2?');
    await handleMessage(ctx, { runtime: runtimeWith('4'), agentName: 'assistant' });

    expect(replies).toEqual(['4']);
  });

  it('replies with an apology when the agent run fails', async () => {
    const { ctx, replies } = fakeContext('break please');
    const runtime = buildAgentRuntime({
      model: new BrokenModel(),
      executor: toolExecutor([]),
    });

    await handleMessage(ctx, { runtime, logger: spyLogger() });

    expect(replies[0]).toMatch(/something went wrong/i);
  });

  it('records the message via the remember hook, scoped by chat id', async () => {
    const { ctx } = fakeContext('remember this');
    const seen: { subject: string; text: string }[] = [];
    await handleMessage(ctx, {
      runtime: runtimeWith('ok'),
      remember: (subject, text) => {
        seen.push({ subject, text });
        return Promise.resolve();
      },
    });
    expect(seen).toEqual([{ subject: '42', text: 'remember this' }]);
  });

  it('does not break when the remember hook throws', async () => {
    const { ctx, replies } = fakeContext('hello');
    const logger = spyLogger();
    await handleMessage(ctx, {
      runtime: runtimeWith('hi'),
      remember: () => Promise.reject(new Error('disk full')),
      logger,
    });
    expect(replies).toEqual(['hi']); // the reply still went out
    expect(logger.warns).toContain('memory write failed');
  });
});

describe('registerHandlers', () => {
  it('registers /start and a text handler, and /start greets', async () => {
    let startHandler: Handler | undefined;
    let textHandler: Handler | undefined;
    const bot: CommandBot = {
      command: (name, handler) => {
        expect(name).toBe('start');
        startHandler = handler;
      },
      onText: (handler) => {
        textHandler = handler;
      },
    };

    registerHandlers(bot, { runtime: runtimeWith('hello') });

    expect(startHandler).toBeTypeOf('function');
    expect(textHandler).toBeTypeOf('function');

    const { ctx, replies } = fakeContext('/start');
    await startHandler?.(ctx);
    expect(replies[0]).toMatch(/I am Hermes/);
  });
});
