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

export interface BotDeps {
  readonly runtime: AgentRuntime;
  /** Which registered agent to run. Defaults to the assistant. */
  readonly agentName?: string;
  readonly logger?: Logger;
  /** Record a message for later recall, scoped to this chat. Best-effort. */
  readonly remember?: (subject: string, text: string) => Promise<unknown>;
  /** Ingest the docs folder into memory; returns a human-readable summary. */
  readonly onIngest?: () => Promise<string>;
}

/** The slice of `TelegramBot` this module needs — the two registration methods. */
export interface CommandBot {
  command(name: string, handler: Handler): unknown;
  onText(handler: Handler): unknown;
}

/** Run one message through the agent and reply with the outcome. */
export async function handleMessage(ctx: MessageContext, deps: BotDeps): Promise<void> {
  const text = ctx.text.trim();
  if (text === '') {
    await ctx.reply('Send me a task in text and I will work on it.');
    return;
  }

  // The chat id scopes memory: each chat recalls only its own history.
  const subject = String(ctx.message.chat.id);

  try {
    const result = await deps.runtime.run(deps.agentName ?? AGENT_NAME, {
      input: text,
      subject,
    });
    await ctx.reply(replyText(result));
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
      await ctx.reply('Ingesting documents…');
      try {
        await ctx.reply(await onIngest());
      } catch (thrown) {
        deps.logger?.error('ingest failed', { error: (thrown as Error).message });
        await ctx.reply('Ingest failed. Check the docs folder and try again.');
      }
    });
  }
  bot.onText((ctx) => handleMessage(ctx, deps));
  return bot;
}
