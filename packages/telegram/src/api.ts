/**
 * A minimal typing of the Telegram Bot API — just the objects Hermes uses.
 *
 * The full API is enormous; modelling all of it would be a maintenance burden
 * for no gain. This is the subset a chat interface needs — receive a text
 * message, know who and where it came from, send one back — with the wire field
 * names (`message_id`, `first_name`) kept verbatim so the JSON maps directly.
 */

export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  /** `private`, `group`, `supergroup`, or `channel`. */
  readonly type: string;
  readonly title?: string;
  readonly username?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

/** The envelope every Bot API method returns. */
export type ApiResponse<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error_code: number; readonly description: string };
