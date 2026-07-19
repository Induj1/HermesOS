/**
 * Wiring the chat to the agent: an incoming message becomes an agent run, and
 * the agent's decision becomes a reply.
 *
 * `handleMessage` is a pure function of a message context and its deps, so it is
 * tested with a fake context and a fake-model runtime — no Telegram, no network.
 * `registerHandlers` attaches it to a bot; it takes a structural `CommandBot` so
 * a test can pass a recorder and `main.ts` can pass a real `TelegramBot`.
 */

import type { AgentRuntime } from '@hermes/agent';
import type { Logger } from '@hermes/kernel';
import type { Handler, MessageContext } from '@hermes/telegram';
import { AGENT_NAME, replyText } from './agent.js';
import { isRemoveBgRequest } from './bg.js';
import type { ConversationHistory } from './conversation.js';
import { isOcrRequest } from './ocr.js';
import { isQrScanRequest } from './qr.js';
import { parseReminder } from './reminders.js';
import { parseTranslateCommand } from './translate.js';
import {
  isTransformRequest,
  largestPhoto,
  visionPrompt,
  type PhotoSize,
} from './vision.js';

export interface BotDeps {
  readonly runtime: AgentRuntime;
  /** Which registered agent to run. Defaults to the assistant. */
  readonly agentName?: string;
  readonly logger?: Logger;
  /** Record a message for later recall, scoped to this chat. Best-effort. */
  readonly remember?: (subject: string, text: string) => Promise<unknown>;
  /** Ingest the docs folder into memory; returns a human-readable summary. */
  readonly onIngest?: () => Promise<string>;
  /** Ingest a web page by URL into memory; returns a summary. */
  readonly onIngestUrl?: (url: string) => Promise<string>;
  /** Ingest a local source repo for code Q&A; returns a summary. */
  readonly onRepo?: (path: string) => Promise<string>;
  /** Narrate a workspace document to the chat as an audio track. */
  readonly onAudiobook?: (path: string, chatId: number) => Promise<void>;
  /** Generate a short animated clip from a prompt and send it. */
  readonly onVideo?: (prompt: string, chatId: number) => Promise<void>;
  /** Schedule a reminder; returns an acknowledgement. */
  readonly onRemind?: (chatId: number, ms: number, message: string) => Promise<string>;
  /** Screenshot a URL and send it to the chat as a photo. */
  readonly onScreenshot?: (url: string, chatId: number) => Promise<void>;
  /** Generate an image from a prompt and send it to the chat as a photo. */
  readonly onImagine?: (prompt: string, chatId: number) => Promise<void>;
  /** Send a workspace file to the chat as a document. */
  readonly onGet?: (filePath: string, chatId: number) => Promise<void>;
  /** Generate a music clip from a prompt and send it. */
  readonly onMusic?: (prompt: string, chatId: number) => Promise<void>;
  /** Describe a photo (by Telegram file id) with a vision model. */
  readonly onPhoto?: (
    fileId: string,
    prompt: string,
    subject: string,
  ) => Promise<string>;
  /** Read the text out of a photo (by Telegram file id) with OCR. */
  readonly onOcr?: (fileId: string) => Promise<string>;
  /** Decode a QR code in a photo (by Telegram file id) to its payload. */
  readonly onQr?: (fileId: string) => Promise<string>;
  /** Generate a QR code from text and send it to the chat as a photo. */
  readonly onQrMake?: (text: string, chatId: number) => Promise<void>;
  /** Remove a photo's background and send back a transparent cutout. */
  readonly onRemoveBg?: (fileId: string, chatId: number) => Promise<void>;
  /** Transcribe a voice note (by Telegram file id) to text. */
  readonly onVoice?: (fileId: string) => Promise<string>;
  /** Transcribe an uploaded audio/video file (by Telegram file id) to text. */
  readonly onTranscribeFile?: (fileId: string) => Promise<string>;
  /** Translate text into a target language. */
  readonly onTranslate?: (targetLang: string, text: string) => Promise<string>;
  /** Transform a photo (img2img) by prompt and send the result. */
  readonly onImg2img?: (
    fileId: string,
    prompt: string,
    chatId: number,
  ) => Promise<void>;
  /** Speak a reply back to a chat as a voice note. */
  readonly speak?: (chatId: number, text: string) => Promise<void>;
  /** Chat ids allowed to use the bot. Empty/undefined = everyone. */
  readonly allowedChatIds?: readonly string[];
  /** Short-term per-chat conversation history for coherent follow-ups. */
  readonly history?: ConversationHistory;
}

/** Whether a chat may use the bot. An empty allowlist permits everyone. */
export function isAllowed(subject: string, allowed?: readonly string[]): boolean {
  return allowed === undefined || allowed.length === 0 || allowed.includes(subject);
}

/** Photo + caption off the raw update — fields @hermes/telegram does not type. */
function photoOf(message: unknown): { photo?: readonly PhotoSize[]; caption?: string } {
  return message as { photo?: readonly PhotoSize[]; caption?: string };
}

/** The voice note's file id off the raw update, if present. */
function voiceFileId(message: unknown): string | undefined {
  return (message as { voice?: { file_id?: string } }).voice?.file_id;
}

/** An uploaded audio/video file's id (audio, video, video_note, or an A/V document). */
function mediaFileId(message: unknown): string | undefined {
  const m = message as {
    audio?: { file_id?: string };
    video?: { file_id?: string };
    video_note?: { file_id?: string };
    document?: { file_id?: string; mime_type?: string };
  };
  if (m.audio?.file_id !== undefined) return m.audio.file_id;
  if (m.video?.file_id !== undefined) return m.video.file_id;
  if (m.video_note?.file_id !== undefined) return m.video_note.file_id;
  const doc = m.document;
  if (doc?.file_id !== undefined && /^(audio|video)\//.test(doc.mime_type ?? '')) {
    return doc.file_id;
  }
  return undefined;
}

/** The slice of `TelegramBot` this module needs — the two registration methods. */
export interface CommandBot {
  command(name: string, handler: Handler): unknown;
  onText(handler: Handler): unknown;
}

/** Run one message through the agent and reply with the outcome. */
export async function handleMessage(ctx: MessageContext, deps: BotDeps): Promise<void> {
  // The chat id scopes memory: each chat recalls only its own history.
  const subject = String(ctx.message.chat.id);

  // Access control: the bot runs shell commands, so it must not answer strangers.
  if (!isAllowed(subject, deps.allowedChatIds)) {
    await ctx.reply(
      `Sorry, this bot is private. If it is yours, add this chat id to ALLOWED_CHAT_IDS: ${subject}`,
    );
    return;
  }

  // A photo: transform it (img2img) if the caption asks, else describe it.
  const { photo, caption } = photoOf(ctx.message);
  const largest = largestPhoto(photo);
  if (largest !== undefined) {
    const cap = caption ?? '';
    if (isRemoveBgRequest(cap) && deps.onRemoveBg !== undefined) {
      await ctx.reply('✂️ Removing the background…');
      try {
        await deps.onRemoveBg(largest.file_id, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('removebg failed', { error: (thrown as Error).message });
        await ctx.reply('I could not remove the background.');
      }
      return;
    }
    if (isOcrRequest(cap) && deps.onOcr !== undefined) {
      await ctx.reply('🔎 Reading the text…');
      try {
        const text = (await deps.onOcr(largest.file_id)).trim();
        await ctx.reply(text === '' ? '(no text found in that image)' : text);
      } catch (thrown) {
        deps.logger?.error('ocr failed', { error: (thrown as Error).message });
        await ctx.reply('I could not read that image.');
      }
      return;
    }
    if (isQrScanRequest(cap) && deps.onQr !== undefined) {
      await ctx.reply('🔳 Scanning the QR code…');
      try {
        const payload = (await deps.onQr(largest.file_id)).trim();
        await ctx.reply(payload === '' ? '(no QR code found in that image)' : payload);
      } catch (thrown) {
        deps.logger?.error('qr scan failed', { error: (thrown as Error).message });
        await ctx.reply('I could not scan that QR code.');
      }
      return;
    }
    if (isTransformRequest(cap) && deps.onImg2img !== undefined) {
      await ctx.reply('🎨 Reimagining your image…');
      try {
        await deps.onImg2img(largest.file_id, cap, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('img2img failed', { error: (thrown as Error).message });
        await ctx.reply('I could not transform that image.');
      }
      return;
    }
    if (deps.onPhoto !== undefined) {
      await ctx.reply('Looking at your image…');
      try {
        await ctx.reply(
          await deps.onPhoto(largest.file_id, visionPrompt(cap), subject),
        );
      } catch (thrown) {
        deps.logger?.error('vision failed', { error: (thrown as Error).message });
        await ctx.reply('I could not process that image.');
      }
      return;
    }
  }

  // An uploaded audio/video file: transcribe it and hand back the transcript
  // (unlike a voice note, we don't run it as a task — the file *is* the ask).
  const mediaId = mediaFileId(ctx.message);
  if (mediaId !== undefined && deps.onTranscribeFile !== undefined) {
    await ctx.reply('Transcribing your file… (this can take a while)');
    try {
      const transcript = (await deps.onTranscribeFile(mediaId)).trim();
      await ctx.reply(transcript === '' ? '(no speech detected)' : transcript);
    } catch (thrown) {
      deps.logger?.error('file transcription failed', {
        error: (thrown as Error).message,
      });
      await ctx.reply('I could not transcribe that file.');
    }
    return;
  }

  // A voice note: transcribe it, then treat the transcript as the task.
  let text = ctx.text.trim();
  const voiceId = voiceFileId(ctx.message);
  const cameByVoice = voiceId !== undefined && deps.onVoice !== undefined;
  if (voiceId !== undefined && deps.onVoice !== undefined) {
    await ctx.reply('Transcribing your voice note…');
    try {
      text = (await deps.onVoice(voiceId)).trim();
    } catch (thrown) {
      deps.logger?.error('transcription failed', { error: (thrown as Error).message });
      await ctx.reply('I could not transcribe that voice note.');
      return;
    }
    if (text !== '') await ctx.reply(`🎙 "${text}"`);
  }

  if (text === '') {
    await ctx.reply('Send me a task in text and I will work on it.');
    return;
  }

  try {
    const historyText = deps.history?.render(subject) ?? '';
    const result = await deps.runtime.run(deps.agentName ?? AGENT_NAME, {
      input: text,
      subject,
      ...(historyText === '' ? {} : { context: { history: historyText } }),
    });
    const reply = replyText(result);
    await ctx.reply(reply);
    // Record the exchange for coherent follow-ups.
    deps.history?.add(subject, 'user', text);
    deps.history?.add(subject, 'assistant', reply);
    // If they spoke to us, speak back.
    if (cameByVoice && deps.speak !== undefined) {
      try {
        await deps.speak(ctx.message.chat.id, reply);
      } catch (thrown) {
        deps.logger?.warn('tts failed', { error: (thrown as Error).message });
      }
    }
  } catch (thrown) {
    deps.logger?.error('agent run failed', { error: (thrown as Error).message });
    await ctx.reply('Something went wrong while working on that. Please try again.');
  }

  // Remember the message after replying, so a slow or failed write never delays
  // or breaks the answer.
  if (deps.remember !== undefined) {
    try {
      await deps.remember(subject, text);
    } catch (thrown) {
      deps.logger?.warn('memory write failed', { error: (thrown as Error).message });
    }
  }
}

/** Attach `/start` and the message handler to a bot. Returns the bot for chaining. */
export function registerHandlers<TBot extends CommandBot>(
  bot: TBot,
  deps: BotDeps,
): TBot {
  bot.command('start', (ctx) =>
    ctx.reply(
      'Hi! I am Hermes. Send me a task — for example, ' +
        '"summarise notes.md" or "fetch https://example.com and tell me the title". ' +
        'Drop files in the docs folder and send /ingest to chat with them.',
    ),
  );
  if (deps.onIngest !== undefined) {
    const onIngest = deps.onIngest;
    bot.command('ingest', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      await ctx.reply('Ingesting documents…');
      try {
        await ctx.reply(await onIngest());
      } catch (thrown) {
        deps.logger?.error('ingest failed', { error: (thrown as Error).message });
        await ctx.reply('Ingest failed. Check the docs folder and try again.');
      }
    });
  }
  if (deps.onIngestUrl !== undefined) {
    const onIngestUrl = deps.onIngestUrl;
    bot.command('ingesturl', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const url = ctx.args[0];
      if (url === undefined) {
        await ctx.reply('Usage: /ingesturl <url>');
        return;
      }
      await ctx.reply('Fetching and ingesting…');
      try {
        await ctx.reply(await onIngestUrl(url));
      } catch (thrown) {
        deps.logger?.error('url ingest failed', { error: (thrown as Error).message });
        await ctx.reply('Could not ingest that URL.');
      }
    });
  }
  if (deps.onRemind !== undefined) {
    const onRemind = deps.onRemind;
    bot.command('remind', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const parsed = parseReminder(ctx.args.join(' '));
      if (parsed === undefined) {
        await ctx.reply('Usage: /remind <30m|2h|1d> <message>');
        return;
      }
      try {
        await ctx.reply(await onRemind(ctx.message.chat.id, parsed.ms, parsed.message));
      } catch (thrown) {
        deps.logger?.error('reminder failed', { error: (thrown as Error).message });
        await ctx.reply('Could not set that reminder.');
      }
    });
  }
  if (deps.onScreenshot !== undefined) {
    const onScreenshot = deps.onScreenshot;
    bot.command('screenshot', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const url = ctx.args[0];
      if (url === undefined) {
        await ctx.reply('Usage: /screenshot <url>');
        return;
      }
      await ctx.reply('📸 Capturing…');
      try {
        await onScreenshot(url, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('screenshot failed', { error: (thrown as Error).message });
        await ctx.reply('Could not capture that page.');
      }
    });
  }
  if (deps.onImagine !== undefined) {
    const onImagine = deps.onImagine;
    bot.command('imagine', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const prompt = ctx.args.join(' ').trim();
      if (prompt === '') {
        await ctx.reply('Usage: /imagine <prompt>');
        return;
      }
      await ctx.reply('🎨 Generating (this can take a moment)…');
      try {
        await onImagine(prompt, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('imagine failed', { error: (thrown as Error).message });
        await ctx.reply('Could not generate that image.');
      }
    });
  }
  if (deps.onGet !== undefined) {
    const onGet = deps.onGet;
    bot.command('get', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const file = ctx.args[0];
      if (file === undefined) {
        await ctx.reply('Usage: /get <path> (a file in the workspace)');
        return;
      }
      try {
        await onGet(file, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('get failed', { error: (thrown as Error).message });
        await ctx.reply('Could not find or send that file.');
      }
    });
  }
  if (deps.onMusic !== undefined) {
    const onMusic = deps.onMusic;
    bot.command('music', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const prompt = ctx.args.join(' ').trim();
      if (prompt === '') {
        await ctx.reply('Usage: /music <description>');
        return;
      }
      await ctx.reply('🎵 Composing (this can take a minute)…');
      try {
        await onMusic(prompt, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('music failed', { error: (thrown as Error).message });
        await ctx.reply('Could not generate that music.');
      }
    });
  }
  if (deps.onRepo !== undefined) {
    const onRepo = deps.onRepo;
    bot.command('repo', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const repoPath = ctx.args.join(' ').trim();
      if (repoPath === '') {
        await ctx.reply('Usage: /repo <path to a local repo>');
        return;
      }
      await ctx.reply('📚 Indexing the repo…');
      try {
        await ctx.reply(await onRepo(repoPath));
      } catch (thrown) {
        deps.logger?.error('repo index failed', { error: (thrown as Error).message });
        await ctx.reply('Could not index that repo.');
      }
    });
  }
  if (deps.onAudiobook !== undefined) {
    const onAudiobook = deps.onAudiobook;
    bot.command('audiobook', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const file = ctx.args.join(' ').trim();
      if (file === '') {
        await ctx.reply('Usage: /audiobook <path> (a doc in the workspace)');
        return;
      }
      await ctx.reply('🎧 Narrating (this can take a moment)…');
      try {
        await onAudiobook(file, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('audiobook failed', { error: (thrown as Error).message });
        await ctx.reply('Could not narrate that document.');
      }
    });
  }
  if (deps.onVideo !== undefined) {
    const onVideo = deps.onVideo;
    bot.command('video', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const prompt = ctx.args.join(' ').trim();
      if (prompt === '') {
        await ctx.reply('Usage: /video <prompt>');
        return;
      }
      await ctx.reply('🎬 Generating a clip (this can take a minute)…');
      try {
        await onVideo(prompt, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('video failed', { error: (thrown as Error).message });
        await ctx.reply('Could not generate that video.');
      }
    });
  }
  if (deps.onQrMake !== undefined) {
    const onQrMake = deps.onQrMake;
    bot.command('qr', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const text = ctx.args.join(' ').trim();
      if (text === '') {
        await ctx.reply('Usage: /qr <text or url>');
        return;
      }
      try {
        await onQrMake(text, ctx.message.chat.id);
      } catch (thrown) {
        deps.logger?.error('qr make failed', { error: (thrown as Error).message });
        await ctx.reply('Could not generate that QR code.');
      }
    });
  }
  if (deps.onTranslate !== undefined) {
    const onTranslate = deps.onTranslate;
    bot.command('translate', async (ctx) => {
      if (!isAllowed(String(ctx.message.chat.id), deps.allowedChatIds)) return;
      const parsed = parseTranslateCommand(ctx.args);
      if (parsed === undefined) {
        await ctx.reply('Usage: /translate <language> <text>');
        return;
      }
      try {
        await ctx.reply(await onTranslate(parsed.to, parsed.text));
      } catch (thrown) {
        deps.logger?.error('translate failed', { error: (thrown as Error).message });
        await ctx.reply('Could not translate that.');
      }
    });
  }
  bot.onText((ctx) => handleMessage(ctx, deps));
  return bot;
}
