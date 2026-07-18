/**
 * The Telegram Bot API client — typed methods over an injected `HttpClient`.
 *
 * Every Bot API call is `POST {baseUrl}/bot{token}/{method}` with a JSON body,
 * answering `{ ok: true, result }` or `{ ok: false, error_code, description }`.
 * This client wraps that: it serializes params, unwraps the envelope, and turns
 * a non-`ok` body (or a transport failure) into a `TelegramError`. The transport
 * is injected, so the client is tested against a `FakeHttpClient` driving a
 * `FakeTelegramServer` — no network, and the token never leaves the URL.
 */

import type { HttpClient } from '@hermes/tools-http';
import type {
  ApiResponse,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './api.js';
import { TelegramError } from './errors.js';

export interface TelegramClientOptions {
  /** The bot token from @BotFather. Appears only in the request URL path. */
  readonly token: string;
  readonly http: HttpClient;
  /** Override the API base (default `https://api.telegram.org`). */
  readonly baseUrl?: string;
}

export interface SendMessageParams {
  readonly chatId: number;
  readonly text: string;
  /** `MarkdownV2`, `HTML`, or none. */
  readonly parseMode?: string;
  /** Reply to a specific message. */
  readonly replyToMessageId?: number;
}

export interface GetUpdatesParams {
  /** Only updates with `update_id >= offset` — the ack mechanism. */
  readonly offset?: number;
  readonly limit?: number;
  /** Long-poll timeout in seconds (server-side hold). */
  readonly timeoutSeconds?: number;
}

export class TelegramClient {
  readonly #token: string;
  readonly #http: HttpClient;
  readonly #baseUrl: string;

  constructor(options: TelegramClientOptions) {
    this.#token = options.token;
    this.#http = options.http;
    this.#baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  }

  /** Confirm the token and get the bot's identity. */
  getMe(): Promise<TelegramUser> {
    return this.#call<TelegramUser>('getMe', {});
  }

  /** Send a text message to a chat. */
  sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    return this.#call<TelegramMessage>('sendMessage', {
      chat_id: params.chatId,
      text: params.text,
      ...(params.parseMode === undefined ? {} : { parse_mode: params.parseMode }),
      ...(params.replyToMessageId === undefined
        ? {}
        : { reply_to_message_id: params.replyToMessageId }),
    });
  }

  /** Fetch pending updates. `offset` acknowledges everything below it. */
  getUpdates(params: GetUpdatesParams = {}): Promise<readonly TelegramUpdate[]> {
    const body: Record<string, unknown> = {};
    if (params.offset !== undefined) body['offset'] = params.offset;
    if (params.limit !== undefined) body['limit'] = params.limit;
    if (params.timeoutSeconds !== undefined) body['timeout'] = params.timeoutSeconds;
    return this.#call<readonly TelegramUpdate[]>('getUpdates', body);
  }

  async #call<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    let response;
    try {
      response = await this.#http.request({
        url: `${this.#baseUrl}/bot${this.#token}/${method}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (error) {
      // A transport failure carries no API code; surface it as a 0-coded error
      // rather than leaking the URL (which contains the token) in the message.
      throw new TelegramError(method, 0, messageOf(error));
    }

    const parsed = parseBody<T>(response.body);
    if (parsed === undefined) {
      throw new TelegramError(
        method,
        response.status,
        `non-JSON response (status ${String(response.status)})`,
      );
    }
    if (!parsed.ok) {
      throw new TelegramError(method, parsed.error_code, parsed.description);
    }
    return parsed.result;
  }
}

function parseBody<T>(body: string): ApiResponse<T> | undefined {
  try {
    return JSON.parse(body) as ApiResponse<T>;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
