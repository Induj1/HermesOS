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

  it('reads text from a photo captioned for OCR', async () => {
    const { ctx, replies } = fakePhotoContext('read this', [
      { file_id: 'doc', width: 800, height: 600 },
    ]);
    const seen: string[] = [];
    await handleMessage(ctx, {
      runtime: runtimeWith('unused'),
      onOcr: (fileId) => {
        seen.push(fileId);
        return Promise.resolve('INVOICE #42');
      },
      onPhoto: () => Promise.resolve('should not run'),
    });
    expect(seen).toEqual(['doc']);
    expect(replies).toContain('INVOICE #42');
  });

  it('extracts structured JSON from a receipt-captioned photo', async () => {
    const seen: string[] = [];
    const ok = fakePhotoContext('receipt', [{ file_id: 'r', width: 600, height: 800 }]);
    await handleMessage(ok.ctx, {
      runtime: runtimeWith('x'),
      onExtract: (fileId) => {
        seen.push(fileId);
        return Promise.resolve('{"merchant":"Cafe","total":9.5}');
      },
      onOcr: () => Promise.resolve('should not run'),
    });
    expect(seen).toEqual(['r']);
    expect(ok.replies).toContain('{"merchant":"Cafe","total":9.5}');

    const fail = fakePhotoContext('extract the fields', [
      { file_id: 'f', width: 9, height: 9 },
    ]);
    await handleMessage(fail.ctx, {
      runtime: runtimeWith('x'),
      onExtract: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(fail.replies.some((r) => /could not extract/i.test(r))).toBe(true);
  });

  it('reports empty OCR results and apologises on OCR failure', async () => {
    const empty = fakePhotoContext('ocr', [{ file_id: 'a', width: 9, height: 9 }]);
    await handleMessage(empty.ctx, {
      runtime: runtimeWith('x'),
      onOcr: () => Promise.resolve('   '),
    });
    expect(empty.replies.some((r) => /no text found/i.test(r))).toBe(true);

    const fail = fakePhotoContext('read this', [{ file_id: 'b', width: 9, height: 9 }]);
    await handleMessage(fail.ctx, {
      runtime: runtimeWith('x'),
      onOcr: () => Promise.reject(new Error('no tesseract')),
      logger: spyLogger(),
    });
    expect(fail.replies.some((r) => /could not read/i.test(r))).toBe(true);
  });

  it('removes a photo background when the caption asks, and apologises on failure', async () => {
    const seen: { id: string; chatId: number }[] = [];
    const ok = fakePhotoContext('remove the background', [
      { file_id: 'p', width: 800, height: 600 },
    ]);
    await handleMessage(ok.ctx, {
      runtime: runtimeWith('x'),
      onRemoveBg: (id, chatId) => {
        seen.push({ id, chatId });
        return Promise.resolve();
      },
      onPhoto: () => Promise.resolve('should not run'),
    });
    expect(seen).toEqual([{ id: 'p', chatId: 42 }]);

    const fail = fakePhotoContext('removebg', [{ file_id: 'q', width: 9, height: 9 }]);
    await handleMessage(fail.ctx, {
      runtime: runtimeWith('x'),
      onRemoveBg: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(fail.replies.some((r) => /could not remove the background/i.test(r))).toBe(
      true,
    );
  });

  it('routes inpaint and upscale captions, passing the parsed target', async () => {
    const inpaints: { id: string; target: string }[] = [];
    const inp = fakePhotoContext('erase the person on the left', [
      { file_id: 'i', width: 800, height: 600 },
    ]);
    await handleMessage(inp.ctx, {
      runtime: runtimeWith('x'),
      onInpaint: (id, target) => {
        inpaints.push({ id, target });
        return Promise.resolve();
      },
      onPhoto: () => Promise.resolve('should not run'),
    });
    expect(inpaints).toEqual([{ id: 'i', target: 'the person on the left' }]);

    const upscaled: string[] = [];
    const up = fakePhotoContext('enhance this', [
      { file_id: 'u', width: 200, height: 200 },
    ]);
    await handleMessage(up.ctx, {
      runtime: runtimeWith('x'),
      onUpscale: (id) => {
        upscaled.push(id);
        return Promise.resolve();
      },
    });
    expect(upscaled).toEqual(['u']);

    // "remove the background" is rembg's job, not inpaint.
    const bg: string[] = [];
    const bgCtx = fakePhotoContext('remove the background', [
      { file_id: 'b', width: 200, height: 200 },
    ]);
    await handleMessage(bgCtx.ctx, {
      runtime: runtimeWith('x'),
      onRemoveBg: (id) => {
        bg.push(id);
        return Promise.resolve();
      },
      onInpaint: () => Promise.reject(new Error('should not run')),
    });
    expect(bg).toEqual(['b']);

    // Both effects apologise on failure.
    const inpFail = fakePhotoContext('erase the sign', [
      { file_id: 'x', width: 9, height: 9 },
    ]);
    await handleMessage(inpFail.ctx, {
      runtime: runtimeWith('x'),
      onInpaint: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(inpFail.replies.some((r) => /could not edit/i.test(r))).toBe(true);

    const upFail = fakePhotoContext('upscale', [{ file_id: 'y', width: 9, height: 9 }]);
    await handleMessage(upFail.ctx, {
      runtime: runtimeWith('x'),
      onUpscale: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(upFail.replies.some((r) => /could not upscale/i.test(r))).toBe(true);
  });

  it('splits stems on an audio caption, else transcribes', async () => {
    const audioCtx = (caption: string) => {
      const replies: string[] = [];
      const ctx = {
        text: '',
        command: undefined,
        args: [],
        message: { chat: { id: 42 }, audio: { file_id: 'song' }, caption },
        reply: (m: string) => {
          replies.push(m);
          return Promise.resolve(undefined);
        },
      } as unknown as MessageContext;
      return { ctx, replies };
    };

    const stems: { id: string; choice: string }[] = [];
    const karaoke = audioCtx('karaoke');
    await handleMessage(karaoke.ctx, {
      runtime: runtimeWith('x'),
      onStemSplit: (id, choice) => {
        stems.push({ id, choice });
        return Promise.resolve();
      },
      onTranscribeFile: () => Promise.resolve('should not run'),
    });
    expect(stems).toEqual([{ id: 'song', choice: 'instrumental' }]);

    // No stem caption → falls through to transcription.
    const plain = audioCtx('');
    await handleMessage(plain.ctx, {
      runtime: runtimeWith('x'),
      onStemSplit: () => Promise.reject(new Error('should not run')),
      onTranscribeFile: () => Promise.resolve('the transcript'),
    });
    expect(plain.replies).toContain('the transcript');

    // Stem split failure apologises.
    const fail = audioCtx('instrumental');
    await handleMessage(fail.ctx, {
      runtime: runtimeWith('x'),
      onStemSplit: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(fail.replies.some((r) => /could not separate/i.test(r))).toBe(true);
  });

  it('routes photo-studio captions: meme, blur faces, sticker', async () => {
    const memes: { id: string; top: string; bottom: string }[] = [];
    const meme = fakePhotoContext('meme: hello | world', [
      { file_id: 'm', width: 600, height: 600 },
    ]);
    await handleMessage(meme.ctx, {
      runtime: runtimeWith('x'),
      onMeme: (id, top, bottom) => {
        memes.push({ id, top, bottom });
        return Promise.resolve();
      },
      onPhoto: () => Promise.resolve('should not run'),
    });
    expect(memes).toEqual([{ id: 'm', top: 'hello', bottom: 'world' }]);

    const blurred: string[] = [];
    const blur = fakePhotoContext('blur faces', [
      { file_id: 'b', width: 600, height: 600 },
    ]);
    await handleMessage(blur.ctx, {
      runtime: runtimeWith('x'),
      onBlurFaces: (id) => {
        blurred.push(id);
        return Promise.resolve();
      },
    });
    expect(blurred).toEqual(['b']);

    const stickers: string[] = [];
    const stk = fakePhotoContext('sticker', [
      { file_id: 's', width: 600, height: 600 },
    ]);
    await handleMessage(stk.ctx, {
      runtime: runtimeWith('x'),
      onSticker: (id) => {
        stickers.push(id);
        return Promise.resolve();
      },
    });
    expect(stickers).toEqual(['s']);
  });

  it('apologises when a photo-studio effect fails', async () => {
    const meme = fakePhotoContext('meme: a | b', [
      { file_id: 'm', width: 9, height: 9 },
    ]);
    await handleMessage(meme.ctx, {
      runtime: runtimeWith('x'),
      onMeme: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(meme.replies.some((r) => /could not make that meme/i.test(r))).toBe(true);

    const blur = fakePhotoContext('censor faces', [
      { file_id: 'b', width: 9, height: 9 },
    ]);
    await handleMessage(blur.ctx, {
      runtime: runtimeWith('x'),
      onBlurFaces: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(blur.replies.some((r) => /could not blur/i.test(r))).toBe(true);

    const stk = fakePhotoContext('make a sticker', [
      { file_id: 's', width: 9, height: 9 },
    ]);
    await handleMessage(stk.ctx, {
      runtime: runtimeWith('x'),
      onSticker: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(stk.replies.some((r) => /could not make that sticker/i.test(r))).toBe(true);
  });

  it('scans a QR-captioned photo, reports empty, and apologises on failure', async () => {
    const seen: string[] = [];
    const ok = fakePhotoContext('scan qr', [{ file_id: 'q', width: 400, height: 400 }]);
    await handleMessage(ok.ctx, {
      runtime: runtimeWith('x'),
      onQr: (fileId) => {
        seen.push(fileId);
        return Promise.resolve('https://example.com');
      },
      onPhoto: () => Promise.resolve('should not run'),
    });
    expect(seen).toEqual(['q']);
    expect(ok.replies).toContain('https://example.com');

    const empty = fakePhotoContext('read the qr', [
      { file_id: 'e', width: 9, height: 9 },
    ]);
    await handleMessage(empty.ctx, {
      runtime: runtimeWith('x'),
      onQr: () => Promise.resolve('  '),
    });
    expect(empty.replies.some((r) => /no QR code found/i.test(r))).toBe(true);

    const fail = fakePhotoContext('decode qr', [{ file_id: 'f', width: 9, height: 9 }]);
    await handleMessage(fail.ctx, {
      runtime: runtimeWith('x'),
      onQr: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    expect(fail.replies.some((r) => /could not scan/i.test(r))).toBe(true);
  });

  it('transcribes an uploaded audio file and returns the transcript', async () => {
    const replies: string[] = [];
    const ctx = {
      text: '',
      command: undefined,
      args: [],
      message: { chat: { id: 42 }, audio: { file_id: 'song-1' } },
      reply: (m: string) => {
        replies.push(m);
        return Promise.resolve(undefined);
      },
    } as unknown as MessageContext;

    const seen: string[] = [];
    await handleMessage(ctx, {
      runtime: runtimeWith('should not run'),
      onTranscribeFile: (fileId) => {
        seen.push(fileId);
        return Promise.resolve('the lyrics');
      },
    });
    expect(seen).toEqual(['song-1']);
    expect(replies).toContain('the lyrics');
  });

  it('handles an A/V document, empty transcript, and transcription failure', async () => {
    const docCtx = (mime: string, fileId: string) => {
      const replies: string[] = [];
      const ctx = {
        text: '',
        command: undefined,
        args: [],
        message: {
          chat: { id: 42 },
          document: { file_id: fileId, mime_type: mime },
        },
        reply: (m: string) => {
          replies.push(m);
          return Promise.resolve(undefined);
        },
      } as unknown as MessageContext;
      return { ctx, replies };
    };

    const empty = docCtx('video/mp4', 'clip');
    await handleMessage(empty.ctx, {
      runtime: runtimeWith('x'),
      onTranscribeFile: () => Promise.resolve('  '),
    });
    expect(empty.replies.some((r) => /no speech detected/i.test(r))).toBe(true);

    const fail = docCtx('audio/mpeg', 'track');
    await handleMessage(fail.ctx, {
      runtime: runtimeWith('x'),
      onTranscribeFile: () => Promise.reject(new Error('no whisper')),
      logger: spyLogger(),
    });
    expect(fail.replies.some((r) => /could not transcribe that file/i.test(r))).toBe(
      true,
    );

    // A non-A/V document is not treated as media — falls through to the blank prompt.
    const pdf = docCtx('application/pdf', 'paper');
    await handleMessage(pdf.ctx, {
      runtime: runtimeWith('x'),
      onTranscribeFile: () => Promise.resolve('should not run'),
    });
    expect(pdf.replies.some((r) => /Send me a task/i.test(r))).toBe(true);
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

  it('registers /every, /schedules, /unschedule recurring-task commands', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const scheduled: { cron: string; prompt: string }[] = [];
    const cancelled: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onSchedule: (_chatId, cron, prompt) => {
        scheduled.push({ cron, prompt });
        return Promise.resolve(`Scheduled [${cron}]`);
      },
      onSchedules: () => Promise.resolve('• job_1 — [0 9 * * 1-5] digest'),
      onUnschedule: (_chatId, id) => {
        cancelled.push(id);
        return Promise.resolve(`Cancelled ${id}`);
      },
    });

    const ok = ctxWith(['weekdays', '9am', 'summarise', 'issues']);
    await handlers['every']?.(ok.ctx);
    expect(scheduled).toEqual([{ cron: '0 9 * * 1-5', prompt: 'summarise issues' }]);

    const bad = ctxWith(['gibberish']);
    await handlers['every']?.(bad.ctx);
    expect(bad.replies.some((r) => r.includes('Usage'))).toBe(true);

    const list = ctxWith([]);
    await handlers['schedules']?.(list.ctx);
    expect(list.replies.some((r) => r.includes('job_1'))).toBe(true);

    const cancel = ctxWith(['job_1']);
    await handlers['unschedule']?.(cancel.ctx);
    expect(cancelled).toEqual(['job_1']);

    const cancelUsage = ctxWith([]);
    await handlers['unschedule']?.(cancelUsage.ctx);
    expect(cancelUsage.replies.some((r) => r.includes('Usage'))).toBe(true);

    // Not on the allowlist → ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onSchedule: () => Promise.resolve('no'),
      onSchedules: () => Promise.resolve('no'),
      onUnschedule: () => Promise.resolve('no'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['weekdays', '9am', 'x'], 999);
    await handlers['every']?.(denied.ctx);
    await handlers['schedules']?.(denied.ctx);
    await handlers['unschedule']?.(ctxWith(['job_1'], 999).ctx);
    expect(denied.replies).toEqual([]);

    // Failures apologise.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onSchedule: () => Promise.reject(new Error('boom')),
      onSchedules: () => Promise.reject(new Error('boom')),
      onUnschedule: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const sf = ctxWith(['hourly', 'do', 'thing']);
    await handlers['every']?.(sf.ctx);
    expect(sf.replies.some((r) => r.includes('Could not schedule'))).toBe(true);
    const lf = ctxWith([]);
    await handlers['schedules']?.(lf.ctx);
    expect(lf.replies.some((r) => r.includes('Could not list'))).toBe(true);
    const uf = ctxWith(['job_1']);
    await handlers['unschedule']?.(uf.ctx);
    expect(uf.replies.some((r) => r.includes('Could not cancel'))).toBe(true);
  });

  it('registers /musicvideo: runs, shows usage, and handles failure', async () => {
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
      onMusicVideo: (prompt) => {
        made.push(prompt);
        return Promise.resolve();
      },
    });
    const ok = ctxWith(['sunset', 'over', 'the', 'ocean']);
    await handlers['musicvideo']?.(ok.ctx);
    expect(made).toEqual(['sunset over the ocean']);

    const usage = ctxWith([]);
    await handlers['musicvideo']?.(usage.ctx);
    expect(usage.replies.some((r) => r.includes('Usage'))).toBe(true);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onMusicVideo: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['x']);
    await handlers['musicvideo']?.(fail.ctx);
    expect(fail.replies.some((r) => r.includes('Could not produce'))).toBe(true);
  });

  it('registers /repo, /audiobook, /video: run, show usage, reject, and fail', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const repos: string[] = [];
    const books: string[] = [];
    const videos: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onRepo: (p) => {
        repos.push(p);
        return Promise.resolve(`Indexed ${p}`);
      },
      onAudiobook: (p) => {
        books.push(p);
        return Promise.resolve();
      },
      onVideo: (prompt) => {
        videos.push(prompt);
        return Promise.resolve();
      },
    });

    const repo = ctxWith(['/Users/me/proj']);
    await handlers['repo']?.(repo.ctx);
    expect(repos).toEqual(['/Users/me/proj']);
    expect(repo.replies.some((r) => r.includes('Indexed'))).toBe(true);

    const book = ctxWith(['notes.md']);
    await handlers['audiobook']?.(book.ctx);
    expect(books).toEqual(['notes.md']);

    const vid = ctxWith(['a', 'spinning', 'galaxy']);
    await handlers['video']?.(vid.ctx);
    expect(videos).toEqual(['a spinning galaxy']);

    // Usage messages when args are missing.
    for (const cmd of ['repo', 'audiobook', 'video']) {
      const usage = ctxWith([]);
      await handlers[cmd]?.(usage.ctx);
      expect(usage.replies.some((r) => r.includes('Usage'))).toBe(true);
    }

    // Not on the allowlist → ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onRepo: () => Promise.resolve('no'),
      onAudiobook: () => Promise.resolve(),
      onVideo: () => Promise.resolve(),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['x'], 999);
    await handlers['repo']?.(denied.ctx);
    await handlers['audiobook']?.(denied.ctx);
    await handlers['video']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    // Failures apologise.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onRepo: () => Promise.reject(new Error('boom')),
      onAudiobook: () => Promise.reject(new Error('boom')),
      onVideo: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const rf = ctxWith(['x']);
    await handlers['repo']?.(rf.ctx);
    expect(rf.replies.some((r) => r.includes('Could not index'))).toBe(true);
    const bf = ctxWith(['x']);
    await handlers['audiobook']?.(bf.ctx);
    expect(bf.replies.some((r) => r.includes('Could not narrate'))).toBe(true);
    const vf = ctxWith(['x']);
    await handlers['video']?.(vf.ctx);
    expect(vf.replies.some((r) => r.includes('Could not generate that video'))).toBe(
      true,
    );
  });

  it('registers /coverletter, /tailor, /interview career commands', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const prompts: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onCareer: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve('drafted');
      },
    });

    // Cover letter runs with the job text embedded in the prompt.
    const cl = ctxWith(['Security', 'Engineer', 'at', 'Acme']);
    await handlers['coverletter']?.(cl.ctx);
    expect(prompts.at(-1)).toContain('Security Engineer at Acme');
    expect(cl.replies).toContain('drafted');

    // Cover letter with no JD → usage.
    const clUsage = ctxWith([]);
    await handlers['coverletter']?.(clUsage.ctx);
    expect(clUsage.replies.some((r) => r.includes('Usage'))).toBe(true);

    // Tailor requires input too.
    const tailorUsage = ctxWith([]);
    await handlers['tailor']?.(tailorUsage.ctx);
    expect(tailorUsage.replies.some((r) => r.includes('Usage'))).toBe(true);

    // Interview runs even with no argument.
    const iv = ctxWith([]);
    await handlers['interview']?.(iv.ctx);
    expect(prompts.at(-1)).toContain('roles that match my background');

    // Not on the allowlist → ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onCareer: () => Promise.resolve('no'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['x'], 999);
    await handlers['coverletter']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    // Failure apologises.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onCareer: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['a', 'job']);
    await handlers['tailor']?.(fail.ctx);
    expect(fail.replies.some((r) => /could not do that/i.test(r))).toBe(true);
  });

  it('registers /review, /scan, /cve, /arxiv with usage + failure paths', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const seen: string[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onReview: (p) => {
        seen.push(`review:${p.slice(0, 12)}`);
        return Promise.resolve('reviewed');
      },
      onScan: (url) => {
        seen.push(`scan:${url}`);
        return Promise.resolve('graded');
      },
      onCve: (kw) => {
        seen.push(`cve:${kw}`);
        return Promise.resolve('cves');
      },
      onArxiv: (q) => {
        seen.push(`arxiv:${q}`);
        return Promise.resolve('papers');
      },
    });

    await handlers['review']?.(ctxWith(['const', 'x=1']).ctx);
    await handlers['scan']?.(ctxWith(['https://x.test']).ctx);
    await handlers['cve']?.(ctxWith(['nginx']).ctx);
    await handlers['arxiv']?.(ctxWith(['quantum', 'edge']).ctx);
    expect(seen).toContain('scan:https://x.test');
    expect(seen).toContain('cve:nginx');
    expect(seen).toContain('arxiv:quantum edge');
    expect(seen.some((s) => s.startsWith('review:'))).toBe(true);

    // Usage messages when args are missing.
    for (const cmd of ['review', 'scan', 'cve', 'arxiv']) {
      const u = ctxWith([]);
      await handlers[cmd]?.(u.ctx);
      expect(u.replies.some((r) => r.includes('Usage'))).toBe(true);
    }

    // Failures apologise.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onReview: () => Promise.reject(new Error('boom')),
      onScan: () => Promise.reject(new Error('boom')),
      onCve: () => Promise.reject(new Error('boom')),
      onArxiv: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const rf = ctxWith(['x']);
    await handlers['scan']?.(rf.ctx);
    expect(rf.replies.some((r) => /Could not scan/i.test(r))).toBe(true);
    const revf = ctxWith(['code']);
    await handlers['review']?.(revf.ctx);
    expect(revf.replies.some((r) => /could not review/i.test(r))).toBe(true);
    const cvf = ctxWith(['nginx']);
    await handlers['cve']?.(cvf.ctx);
    expect(cvf.replies.some((r) => /Could not fetch CVEs/i.test(r))).toBe(true);
    const axf = ctxWith(['quantum']);
    await handlers['arxiv']?.(axf.ctx);
    expect(axf.replies.some((r) => /Could not search arXiv/i.test(r))).toBe(true);

    // Not on the allowlist → ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onScan: () => Promise.resolve('x'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['https://x'], 999);
    await handlers['scan']?.(denied.ctx);
    expect(denied.replies).toEqual([]);
  });

  it('registers /hash, /encode, /decode offline codec helpers', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    // The codec commands ride along with the security suite (onScan present).
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onScan: () => Promise.resolve(''),
    });

    const h = ctxWith(['sha256', 'abc']);
    await handlers['hash']?.(h.ctx);
    expect(h.replies).toContain(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );

    const e = ctxWith(['base64', 'hi']);
    await handlers['encode']?.(e.ctx);
    expect(e.replies).toContain('aGk=');

    const d = ctxWith(['base64', 'aGk=']);
    await handlers['decode']?.(d.ctx);
    expect(d.replies).toContain('hi');

    // Usage + error paths.
    await handlers['hash']?.(ctxWith(['sha256']).ctx);
    const badKind = ctxWith(['rot13', 'x']);
    await handlers['encode']?.(badKind.ctx);
    expect(badKind.replies.some((r) => r.includes('unknown encoding'))).toBe(true);
    const badAlgo = ctxWith(['crc32', 'x']);
    await handlers['hash']?.(badAlgo.ctx);
    expect(badAlgo.replies.some((r) => r.includes('unknown hash'))).toBe(true);
    const encUsage = ctxWith(['base64']);
    await handlers['decode']?.(encUsage.ctx);
    expect(encUsage.replies.some((r) => r.includes('Usage'))).toBe(true);
  });

  it('registers /apply, /applications, /status tracker commands', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const logged: { company: string; role: string }[] = [];
    const updated: { id: string; status: string }[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onApply: (_c, company, role) => {
        logged.push({ company, role });
        return Promise.resolve('logged');
      },
      onApplications: () => Promise.resolve('list'),
      onAppStatus: (_c, id, status) => {
        updated.push({ id, status });
        return Promise.resolve('updated');
      },
    });

    await handlers['apply']?.(ctxWith(['Acme', '|', 'Security', 'Engineer']).ctx);
    expect(logged).toEqual([{ company: 'Acme', role: 'Security Engineer' }]);

    const list = ctxWith([]);
    await handlers['applications']?.(list.ctx);
    expect(list.replies).toContain('list');

    await handlers['status']?.(ctxWith(['app_1', 'interview']).ctx);
    expect(updated).toEqual([{ id: 'app_1', status: 'interview' }]);

    // Usage: bad status and empty apply.
    const badStatus = ctxWith(['app_1', 'nope']);
    await handlers['status']?.(badStatus.ctx);
    expect(badStatus.replies.some((r) => r.includes('Usage'))).toBe(true);
    const emptyApply = ctxWith([]);
    await handlers['apply']?.(emptyApply.ctx);
    expect(emptyApply.replies.some((r) => r.includes('Usage'))).toBe(true);

    // Failure path.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onApply: () => Promise.reject(new Error('boom')),
      onApplications: () => Promise.reject(new Error('boom')),
      onAppStatus: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['Acme']);
    await handlers['apply']?.(fail.ctx);
    expect(fail.replies.some((r) => /Could not log/i.test(r))).toBe(true);
    const lf = ctxWith([]);
    await handlers['applications']?.(lf.ctx);
    expect(lf.replies.some((r) => /Could not list/i.test(r))).toBe(true);
    const sf = ctxWith(['app_1', 'offer']);
    await handlers['status']?.(sf.ctx);
    expect(sf.replies.some((r) => /Could not update/i.test(r))).toBe(true);

    // Not on the allowlist → ignored.
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onApply: () => Promise.resolve('x'),
      onApplications: () => Promise.resolve('x'),
      onAppStatus: () => Promise.resolve('x'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['Acme'], 999);
    await handlers['apply']?.(denied.ctx);
    await handlers['applications']?.(ctxWith([], 999).ctx);
    await handlers['status']?.(ctxWith(['a', 'offer'], 999).ctx);
    expect(denied.replies).toEqual([]);
  });

  it('registers /qr: generates, shows usage, rejects, and handles failure', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const made: { text: string; chatId: number }[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onQrMake: (text, chatId) => {
        made.push({ text, chatId });
        return Promise.resolve();
      },
    });

    const ok = ctxWith(['https://example.com']);
    await handlers['qr']?.(ok.ctx);
    expect(made).toEqual([{ text: 'https://example.com', chatId: 42 }]);

    const usage = ctxWith([]);
    await handlers['qr']?.(usage.ctx);
    expect(usage.replies.some((r) => r.includes('Usage'))).toBe(true);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onQrMake: () => Promise.resolve(),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['hi'], 999);
    await handlers['qr']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onQrMake: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['hi']);
    await handlers['qr']?.(fail.ctx);
    expect(fail.replies.some((r) => r.includes('Could not generate that QR'))).toBe(
      true,
    );
  });

  it('registers /translate: translates, shows usage, rejects, and handles failure', async () => {
    const handlers: Record<string, Handler> = {};
    const bot: CommandBot = {
      command: (name, handler) => {
        handlers[name] = handler;
      },
      onText: () => undefined,
    };
    const seen: { to: string; text: string }[] = [];
    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onTranslate: (to, text) => {
        seen.push({ to, text });
        return Promise.resolve(`[${to}] ${text}`);
      },
    });

    const ok = ctxWith(['French', 'good', 'morning']);
    await handlers['translate']?.(ok.ctx);
    expect(seen).toEqual([{ to: 'French', text: 'good morning' }]);
    expect(ok.replies).toContain('[French] good morning');

    const usage = ctxWith(['French']);
    await handlers['translate']?.(usage.ctx);
    expect(usage.replies.some((r) => r.includes('Usage'))).toBe(true);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onTranslate: () => Promise.resolve('no'),
      allowedChatIds: ['7'],
    });
    const denied = ctxWith(['French', 'hi'], 999);
    await handlers['translate']?.(denied.ctx);
    expect(denied.replies).toEqual([]);

    registerHandlers(bot, {
      runtime: runtimeWith('x'),
      onTranslate: () => Promise.reject(new Error('boom')),
      logger: spyLogger(),
    });
    const fail = ctxWith(['French', 'hi']);
    await handlers['translate']?.(fail.ctx);
    expect(fail.replies.some((r) => r.includes('Could not translate'))).toBe(true);
  });
});
