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
import type { ConversationHistory } from './conversation.js';
import { parseReminder } from './reminders.js';
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
  /** Schedule a reminder; returns an acknowledgement. */
  readonly onRemind?: (chatId: number, ms: number, message: string) => Promise<string>;
  /** Screenshot a URL and send it to the chat as a photo. */
  readonly onScreenshot?: (url: string, chatId: number) => Promise<void>;
  /** Generate an image from a prompt and send it to the chat as a photo. */
  readonly onImagine?: (prompt: string, chatId: number) => Promise<void>;
  /** Send a workspace file to the chat as a document. */
  readonly onGet?: (filePath: string, chatId: number) => Promise<void>;
  /** Describe a photo (by Telegram file id) with a vision model. */
  readonly onPhoto?: (
    fileId: string,
    prompt: string,
    subject: string,
  ) => Promise<string>;
  /** Transcribe a voice note (by Telegram file id) to text. */
  readonly onVoice?: (fileId: string) => Promise<string>;
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
  bot.onText((ctx) => handleMessage(ctx, deps));
  return bot;
}
