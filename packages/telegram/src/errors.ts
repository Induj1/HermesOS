/**
 * Telegram errors — a Bot API failure or a transport failure, without the token.
 *
 * The API's error is `{ error_code, description }`; a transport failure has no
 * code (rendered as `0`). Crucially, the message names the *method* and the
 * description but never the request URL — which contains the bot token — so a
 * logged or surfaced error cannot leak the credential.
 */

export class TelegramError extends Error {
  readonly method: string;
  /** The Bot API `error_code`, or `0` for a transport failure. */
  readonly code: number;

  constructor(method: string, code: number, description: string) {
    super(`telegram ${method} failed (${String(code)}): ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
  }
}
