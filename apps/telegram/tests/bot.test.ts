import type { Handler, MessageContext } from '@hermes/telegram';
import { describe, expect, it } from 'vitest';
import { buildAgentRuntime } from '../src/agent.js';
import {
  handleMessage,
  isAllowed,
  registerHandlers,
  type CommandBot,
} from '../src/bot.js';
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

describe('isAllowed', () => {
  it('permits everyone when the allowlist is empty', () => {
    expect(isAllowed('42')).toBe(true);
    expect(isAllowed('42', [])).toBe(true);
  });
  it('restricts to the allowlist when set', () => {
    expect(isAllowed('42', ['42'])).toBe(true);
    expect(isAllowed('99', ['42'])).toBe(false);
  });
});

describe('handleMessage', () => {
  it('rejects a chat that is not on the allowlist', async () => {
    const { ctx, replies } = fakeContext('do something');
    await handleMessage(ctx, { runtime: runtimeWith('nope'), allowedChatIds: ['7'] });
    expect(replies[0]).toMatch(/private/i);
    expect(replies[0]).toContain('42'); // shows the chat id to add
  });

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

  it('transcribes a voice note and runs the agent on the transcript', async () => {
    const replies: string[] = [];
    const ctx = {
      text: '',
      command: undefined,
      args: [],
      message: { chat: { id: 42 }, voice: { file_id: 'voice-1' } },
      reply: (m: string) => {
        replies.push(m);
        return Promise.resolve(undefined);
      },
    } as unknown as MessageContext;

    await handleMessage(ctx, {
      runtime: runtimeWith('the answer'),
      onVoice: (fileId) => Promise.resolve(`transcribed ${fileId}`),
    });

    expect(replies).toContain('🎙 "transcribed voice-1"');
    expect(replies).toContain('the answer');
  });

  it('speaks the reply back when the message came by voice', async () => {
    const replies: string[] = [];
    const ctx = {
      text: '',
      command: undefined,
      args: [],
      message: { chat: { id: 42 }, voice: { file_id: 'v' } },
      reply: (m: string) => {
        replies.push(m);
        return Promise.resolve(undefined);
      },
    } as unknown as MessageContext;

    const spoken: { chatId: number; text: string }[] = [];
    await handleMessage(ctx, {
      runtime: runtimeWith('the answer'),
      onVoice: () => Promise.resolve('do the thing'),
      speak: (chatId, text) => {
        spoken.push({ chatId, text });
        return Promise.resolve();
      },
    });
    expect(spoken).toEqual([{ chatId: 42, text: 'the answer' }]);
  });

  it('does not break when speaking the reply fails', async () => {
    const replies: string[] = [];
    const ctx = {
      text: '',
      command: undefined,
      args: [],
      message: { chat: { id: 42 }, voice: { file_id: 'v' } },
      reply: (m: string) => {
        replies.push(m);
        return Promise.resolve(undefined);
      },
    } as unknown as MessageContext;

    await handleMessage(ctx, {
      runtime: runtimeWith('the answer'),
      onVoice: () => Promise.resolve('task'),
      speak: () => Promise.reject(new Error('no say')),
      logger: spyLogger(),
    });
    expect(replies).toContain('the answer'); // text reply still went out
  });

  it('apologises when transcription fails', async () => {
    const replies: string[] = [];
    const ctx = {
      text: '',
      command: undefined,
      args: [],
      message: { chat: { id: 42 }, voice: { file_id: 'v' } },
      reply: (m: string) => {
        replies.push(m);
        return Promise.resolve(undefined);
      },
    } as unknown as MessageContext;

    await handleMessage(ctx, {
      runtime: runtimeWith('unused'),
      onVoice: () => Promise.reject(new Error('no whisper')),
      logger: spyLogger(),
    });

    expect(replies.some((r) => /could not transcribe/i.test(r))).toBe(true);
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
    await handlers['ingest']?.(ok.ctx);
    expect(ok.replies).toContain('Ingested 2 files.');

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onIngest: () => Promise.reject(new Error('nope')),
      logger: spyLogger(),
    });
    const bad = fakeContext('/ingest');
    await handlers['ingest']?.(bad.ctx);
    expect(bad.replies.some((r) => /Ingest failed/i.test(r))).toBe(true);
  });

  const ctxWith = (args: string[], chatId = 42) => {
    const replies: string[] = [];
    const ctx = {
      text: '/ingesturl',
      command: 'ingesturl',
      args,
      message: { chat: { id: chatId } },
      reply: (m: string) => {
        replies.push(m);
        return Promise.resolve(undefined);
      },
    } as unknown as MessageContext;
    return { ctx, replies };
  };

  it('registers /ingesturl: ingests a url, shows usage, and rejects/failures', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onIngestUrl: (url) => Promise.resolve(`Ingested ${url}`),
    });

    const withUrl = ctxWith(['https://example.com']);
    await handlers['ingesturl']?.(withUrl.ctx);
    expect(withUrl.replies.some((r) => r.includes('Ingested https'))).toBe(true);

    const noUrl = ctxWith([]);
    await handlers['ingesturl']?.(noUrl.ctx);
    expect(noUrl.replies.some((r) => r.includes('Usage'))).toBe(true);

    // Not on the allowlist → silently ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onIngestUrl: () => Promise.resolve('should not run'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['https://x.com'], 999);
    await handlers['ingesturl']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    // The ingest throws → apologises.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onIngestUrl: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const failed = ctxWith(['https://x.com']);
    await handlers['ingesturl']?.(failed.ctx);
    expect(failed.replies.some((r) => r.includes('Could not ingest'))).toBe(true);
  });
});
