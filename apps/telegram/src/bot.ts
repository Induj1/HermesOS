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

  try {
    const result = await deps.runtime.run(deps.agentName ?? AGENT_NAME, {
      input: text,
    });
    await ctx.reply(replyText(result));
  } catch (thrown) {
    deps.logger?.error('agent run failed', { error: (thrown as Error).message });
    await ctx.reply('Something went wrong while working on that. Please try again.');
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
        '"summarise notes.md" or "fetch https://example.com and tell me the title".',
    ),
  );
  bot.onText((ctx) => handleMessage(ctx, deps));
  return bot;
}
