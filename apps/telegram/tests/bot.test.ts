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

function fakePhotoContext(
  caption: string,
  photo: { file_id: string; width: number; height: number }[],
): { ctx: MessageContext; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    text: '',
    command: undefined,
    args: [],
    message: { chat: { id: 42 }, photo, caption },
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

  it('describes a photo via the onPhoto hook', async () => {
    const { ctx, replies } = fakePhotoContext('what is this?', [
      { file_id: 'small', width: 90, height: 90 },
      { file_id: 'big', width: 800, height: 600 },
    ]);
    const seen: { fileId: string; prompt: string }[] = [];
    await handleMessage(ctx, {
      runtime: runtimeWith('unused'),
      onPhoto: (fileId, prompt) => {
        seen.push({ fileId, prompt });
        return Promise.resolve('A photo of a cat.');
      },
    });
    expect(seen).toEqual([{ fileId: 'big', prompt: 'what is this?' }]); // largest chosen
    expect(replies).toContain('A photo of a cat.');
  });

  it('apologises when the vision hook fails', async () => {
    const { ctx, replies } = fakePhotoContext('', [
      { file_id: 'x', width: 1, height: 1 },
    ]);
    await handleMessage(ctx, {
      runtime: runtimeWith('unused'),
      onPhoto: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(replies.some((r) => /could not process/i.test(r))).toBe(true);
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

  it('registers /ingest and reports success and failure', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onIngest: () => Promise.resolve('Ingested 2 files.'),
    });
    const ok = fakeContext('/ingest');
    await handlers.ingest?.(ok.ctx);
    expect(ok.replies).toContain('Ingested 2 files.');

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onIngest: () => Promise.reject(new Error('nope')),
      logger: spyLogger(),
    });
    const bad = fakeContext('/ingest');
    await handlers.ingest?.(bad.ctx);
    expect(bad.replies.some((r) => /Ingest failed/i.test(r))).toBe(true);
  });
});
