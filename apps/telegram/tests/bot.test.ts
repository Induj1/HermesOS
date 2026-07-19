import type { Handler, MessageContext } from '@hermes/telegram';
import { describe, expect, it } from 'vitest';
import { buildAgentRuntime } from '../src/agent.js';
import {
  handleMessage,
  isAllowed,
  registerHandlers,
  type CommandBot,
} from '../src/bot.js';
import { ConversationHistory } from '../src/conversation.js';
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

  it('threads conversation history and records the exchange', async () => {
    const { ctx } = fakeContext('second question');
    const history = new ConversationHistory();
    history.add('42', 'user', 'first question');
    history.add('42', 'assistant', 'first answer');

    await handleMessage(ctx, { runtime: runtimeWith('second answer'), history });

    const turns = history.recent('42');
    expect(turns.at(-2)).toEqual({ role: 'user', content: 'second question' });
    expect(turns.at(-1)).toEqual({ role: 'assistant', content: 'second answer' });
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

  it('routes a transform-captioned photo to img2img, else to vision', async () => {
    const img2img: { id: string; prompt: string }[] = [];
    const vision: string[] = [];

    const t = fakePhotoContext('make it a watercolor', [
      { file_id: 'p', width: 800, height: 600 },
    ]);
    await handleMessage(t.ctx, {
      runtime: runtimeWith('x'),
      onImg2img: (id, prompt) => {
        img2img.push({ id, prompt });
        return Promise.resolve();
      },
      onPhoto: () => Promise.resolve('desc'),
    });
    expect(img2img).toEqual([{ id: 'p', prompt: 'make it a watercolor' }]);

    const q = fakePhotoContext('what is this?', [
      { file_id: 'p2', width: 800, height: 600 },
    ]);
    await handleMessage(q.ctx, {
      runtime: runtimeWith('x'),
      onImg2img: () => Promise.resolve(),
      onPhoto: (id) => {
        vision.push(id);
        return Promise.resolve('a cat');
      },
    });
    expect(vision).toEqual(['p2']);

    // img2img failure apologises.
    const f = fakePhotoContext('make it anime', [
      { file_id: 'p3', width: 1, height: 1 },
    ]);
    await handleMessage(f.ctx, {
      runtime: runtimeWith('x'),
      onImg2img: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(f.replies.some((r) => /could not transform/i.test(r))).toBe(true);
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

  it('registers /remind: schedules, shows usage, rejects, and handles failure', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onRemind: (_chatId, ms, message) =>
        Promise.resolve(`set ${String(ms)} ${message}`),
    });

    const ok = ctxWith(['30m', 'call', 'mom']);
    await handlers['remind']?.(ok.ctx);
    expect(ok.replies.some((r) => r.includes('set 1800000 call mom'))).toBe(true);

    const bad = ctxWith(['later']);
    await handlers['remind']?.(bad.ctx);
    expect(bad.replies.some((r) => r.includes('Usage'))).toBe(true);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onRemind: () => Promise.resolve('no'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['30m', 'x'], 999);
    await handlers['remind']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onRemind: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const failed = ctxWith(['30m', 'x']);
    await handlers['remind']?.(failed.ctx);
    expect(failed.replies.some((r) => r.includes('Could not set'))).toBe(true);
  });

  it('registers /screenshot and /imagine media commands', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const shots: string[] = [];
    const images: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onScreenshot: (url) => {
        shots.push(url);
        return Promise.resolve();
      },
      onImagine: (prompt) => {
        images.push(prompt);
        return Promise.resolve();
      },
    });

    const shot = ctxWith(['https://example.com']);
    await handlers['screenshot']?.(shot.ctx);
    expect(shots).toEqual(['https://example.com']);

    const shotUsage = ctxWith([]);
    await handlers['screenshot']?.(shotUsage.ctx);
    expect(shotUsage.replies.some((r) => r.includes('Usage'))).toBe(true);

    const img = ctxWith(['a', 'red', 'fox']);
    await handlers['imagine']?.(img.ctx);
    expect(images).toEqual(['a red fox']);

    const imgUsage = ctxWith([]);
    await handlers['imagine']?.(imgUsage.ctx);
    expect(imgUsage.replies.some((r) => r.includes('Usage'))).toBe(true);

    // Not on the allowlist → ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onScreenshot: () => Promise.reject(new Error('nope')),
      onImagine: () => Promise.reject(new Error('nope')),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['https://x.com'], 999);
    await handlers['screenshot']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    // Failures apologise.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onScreenshot: () => Promise.reject(new Error('boom')),
      onImagine: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const shotFail = ctxWith(['https://x.com']);
    await handlers['screenshot']?.(shotFail.ctx);
    expect(shotFail.replies.some((r) => r.includes('Could not capture'))).toBe(true);
    const imgFail = ctxWith(['a fox']);
    await handlers['imagine']?.(imgFail.ctx);
    expect(imgFail.replies.some((r) => r.includes('Could not generate'))).toBe(true);
  });

  it('registers /get: sends a file, shows usage, and handles failure', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const got: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onGet: (file) => {
        got.push(file);
        return Promise.resolve();
      },
    });

    const ok = ctxWith(['report.pdf']);
    await handlers['get']?.(ok.ctx);
    expect(got).toEqual(['report.pdf']);

    const usage = ctxWith([]);
    await handlers['get']?.(usage.ctx);
    expect(usage.replies.some((r) => r.includes('Usage'))).toBe(true);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onGet: () => Promise.reject(new Error('missing')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['nope.txt']);
    await handlers['get']?.(fail.ctx);
    expect(fail.replies.some((r) => r.includes('Could not find'))).toBe(true);
  });

  it('registers /music: generates, shows usage, and handles failure', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const made: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onMusic: (prompt) => {
        made.push(prompt);
        return Promise.resolve();
      },
    });

    const ok = ctxWith(['lofi', 'beat']);
    await handlers['music']?.(ok.ctx);
    expect(made).toEqual(['lofi beat']);

    const usage = ctxWith([]);
    await handlers['music']?.(usage.ctx);
    expect(usage.replies.some((r) => r.includes('Usage'))).toBe(true);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onMusic: () => Promise.reject(new Error('x')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['x']);
    await handlers['music']?.(fail.ctx);
    expect(fail.replies.some((r) => r.includes('Could not generate'))).toBe(true);
  });
});
