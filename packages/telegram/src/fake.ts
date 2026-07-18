/**
 * A fake Bot API server — the deterministic backend the client is tested on.
 *
 * It exposes a `handler` you hand to `FakeHttpClient`, and it behaves like the
 * real API over the wire: it routes `/bot{token}/{method}`, verifies the token,
 * answers `getMe`/`sendMessage`/`getUpdates` with the `{ ok, result }` envelope,
 * and honours the `offset` acknowledgement on `getUpdates`. Tests enqueue
 * inbound messages and assert on `sent`, so a whole conversation runs with no
 * network — including the failure cases (a bad token, an unknown method) that
 * are awkward to provoke against the real service.
 */

import type { FakeResponse } from '@hermes/tools-http';
import type { HttpRequest } from '@hermes/tools-http';
import type { TelegramMessage, TelegramUpdate, TelegramUser } from './api.js';

export interface FakeServerOptions {
  readonly token: string;
  readonly botUser?: TelegramUser;
}

const DEFAULT_BOT: TelegramUser = {
  id: 1,
  is_bot: true,
  first_name: 'HermesBot',
  username: 'hermes_bot',
};

export class FakeTelegramServer {
  readonly #token: string;
  readonly #botUser: TelegramUser;
  readonly #updates: TelegramUpdate[] = [];
  /** Every message the bot sent, in order — for a test to assert on. */
  readonly sent: TelegramMessage[] = [];
  #nextUpdateId = 1;
  #nextMessageId = 1000;

  constructor(options: FakeServerOptions) {
    this.#token = options.token;
    this.#botUser = options.botUser ?? DEFAULT_BOT;
  }

  /** Queue an inbound text message from a user; returns its update. */
  enqueueMessage(
    text: string,
    options: { chatId?: number; fromId?: number } = {},
  ): TelegramUpdate {
    const chatId = options.chatId ?? 100;
    const update: TelegramUpdate = {
      update_id: this.#nextUpdateId++,
      message: {
        message_id: this.#nextMessageId++,
        from: { id: options.fromId ?? 200, is_bot: false, first_name: 'User' },
        chat: { id: chatId, type: 'private' },
        date: 0,
        text,
      },
    };
    this.#updates.push(update);
    return update;
  }

  /** The `FakeHandler` to back a `FakeHttpClient` with. */
  readonly handler = (req: HttpRequest): FakeResponse => {
    const match = /\/bot([^/]+)\/(\w+)$/.exec(req.url);
    if (match === null)
      return json(404, { ok: false, error_code: 404, description: 'not found' });
    const [, token, method] = match as unknown as [string, string, string];
    if (token !== this.#token) {
      return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    const params = parseParams(req.body);
    switch (method) {
      case 'getMe':
        return json(200, { ok: true, result: this.#botUser });
      case 'getUpdates':
        return json(200, { ok: true, result: this.#getUpdates(params) });
      case 'sendMessage':
        return json(200, { ok: true, result: this.#sendMessage(params) });
      default:
        return json(404, {
          ok: false,
          error_code: 404,
          description: `unknown method ${method}`,
        });
    }
  };

  #getUpdates(params: Readonly<Record<string, unknown>>): readonly TelegramUpdate[] {
    const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
    return this.#updates.filter((u) => u.update_id >= offset);
  }

  #sendMessage(params: Readonly<Record<string, unknown>>): TelegramMessage {
    const chatId = typeof params['chat_id'] === 'number' ? params['chat_id'] : 0;
    const text = typeof params['text'] === 'string' ? params['text'] : '';
    const message: TelegramMessage = {
      message_id: this.#nextMessageId++,
      from: this.#botUser,
      chat: { id: chatId, type: 'private' },
      date: 0,
      text,
    };
    this.sent.push(message);
    return message;
  }
}

function json(status: number, body: unknown): FakeResponse {
  return { status, body: JSON.stringify(body) };
}

function parseParams(body: string | undefined): Readonly<Record<string, unknown>> {
  if (body === undefined || body === '') return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
