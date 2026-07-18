/**
 * The bot — route incoming messages to handlers and drive the long-poll loop.
 *
 * A `TelegramBot` maps a message to either a **command** handler (text that
 * starts with `/name`, optionally `/name@thisbot`) or a **text** fallback. The
 * dispatch (`processUpdates`) is a plain function of the updates it is given, so
 * a test drives it directly; the polling loop (`run`) layers a `Clock`-driven
 * `getUpdates` on top, tracking the offset so each update is delivered once.
 */

import type { Clock } from '@hermes/kernel';
import type { TelegramMessage, TelegramUpdate } from './api.js';
import type { SendMessageParams, TelegramClient } from './client.js';

export interface MessageContext {
  readonly message: TelegramMessage;
  /** The message text (`''` if the message had none). */
  readonly text: string;
  /** For a command, the command name without the slash (e.g. `start`). */
  readonly command: string | undefined;
  /** For a command, the whitespace-split arguments after it. */
  readonly args: readonly string[];
  /** Reply in the same chat. */
  reply(
    text: string,
    options?: Omit<SendMessageParams, 'chatId' | 'text'>,
  ): Promise<unknown>;
}

/**
 * A message handler. Returns anything — `undefined` for a synchronous handler, a
 * promise for an async one — which `processUpdates` awaits. Typed `unknown`
 * rather than `void | Promise<unknown>` so both forms fit without a `void` union.
 */
export type Handler = (ctx: MessageContext) => unknown;

export interface BotOptions {
  readonly client: TelegramClient;
  /** The bot's own username, to strip from `/cmd@username`. */
  readonly username?: string;
}

interface ParsedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export class TelegramBot {
  readonly #client: TelegramClient;
  readonly #username: string | undefined;
  readonly #commands = new Map<string, Handler>();
  #fallback: Handler | undefined;
  #offset = 0;

  constructor(options: BotOptions) {
    this.#client = options.client;
    this.#username = options.username;
  }

  /** Register a handler for `/name`. */
  command(name: string, handler: Handler): this {
    this.#commands.set(name, handler);
    return this;
  }

  /** Register a handler for any text that is not a matched command. */
  onText(handler: Handler): this {
    this.#fallback = handler;
    return this;
  }

  /** Dispatch a batch of updates, returning how many were handled. */
  async processUpdates(updates: readonly TelegramUpdate[]): Promise<number> {
    let handled = 0;
    for (const update of updates) {
      // Advance the offset for every update, handled or not, so a message we do
      // not route is still acknowledged rather than redelivered forever.
      if (update.update_id >= this.#offset) this.#offset = update.update_id + 1;
      if (update.message !== undefined && (await this.#dispatch(update.message))) {
        handled += 1;
      }
    }
    return handled;
  }

  /** One poll: fetch pending updates and dispatch them. Returns the count. */
  async poll(timeoutSeconds = 0): Promise<number> {
    const updates = await this.#client.getUpdates({
      offset: this.#offset,
      timeoutSeconds,
    });
    return this.processUpdates(updates);
  }

  /**
   * Poll forever until `signal` aborts, sleeping `intervalMs` between polls via
   * the injected clock (so tests advance a `TestClock` instead of waiting).
   */
  async run(
    clock: Clock,
    options: { signal: AbortSignal; intervalMs?: number; timeoutSeconds?: number },
  ): Promise<void> {
    const interval = options.intervalMs ?? 1000;
    while (!options.signal.aborted) {
      await this.poll(options.timeoutSeconds ?? 0);
      try {
        await clock.sleep(interval, options.signal);
      } catch {
        // The sleep rejects when the signal aborts; that is the loop's exit.
        return;
      }
    }
  }

  async #dispatch(message: TelegramMessage): Promise<boolean> {
    const text = message.text ?? '';
    const parsed = this.#parseCommand(text);
    const ctx: MessageContext = {
      message,
      text,
      command: parsed?.command,
      args: parsed?.args ?? [],
      reply: (replyText, replyOptions) =>
        this.#client.sendMessage({
          chatId: message.chat.id,
          text: replyText,
          ...replyOptions,
        }),
    };

    if (parsed !== undefined) {
      const handler = this.#commands.get(parsed.command);
      if (handler !== undefined) {
        await handler(ctx);
        return true;
      }
    }
    if (this.#fallback !== undefined) {
      await this.#fallback(ctx);
      return true;
    }
    return false;
  }

  #parseCommand(text: string): ParsedCommand | undefined {
    if (!text.startsWith('/')) return undefined;
    const [head, ...args] = text
      .slice(1)
      .split(/\s+/)
      .filter((s) => s !== '');
    if (head === undefined) return undefined;
    // `/cmd@thisbot` targets a specific bot in a group; strip our own username.
    const at = head.indexOf('@');
    const command = at >= 0 ? head.slice(0, at) : head;
    const target = at >= 0 ? head.slice(at + 1) : undefined;
    if (
      target !== undefined &&
      this.#username !== undefined &&
      target !== this.#username
    ) {
      // Addressed to a different bot in the group — not ours to handle.
      return undefined;
    }
    return { command, args };
  }
}
