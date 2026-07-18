/**
 * Webhook verification — the alternative to long polling.
 *
 * When a bot registers a webhook with a secret token, Telegram sends it back in
 * the `X-Telegram-Bot-Api-Secret-Token` header of every delivery. Verifying it
 * is how a public endpoint tells a genuine Telegram POST from an attacker's.
 * The compare is constant-time so the check does not leak the secret through
 * response timing, and the header lookup is case-insensitive as HTTP requires.
 */

import type { TelegramUpdate } from './api.js';

export const SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

export type Headers = Readonly<Record<string, string | undefined>>;

/** Constant-time string comparison (best-effort in a JS VM). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function header(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Whether the request's secret-token header matches the configured secret. */
export function verifyWebhook(headers: Headers, secret: string): boolean {
  const presented = header(headers, SECRET_TOKEN_HEADER);
  if (presented === undefined) return false;
  return constantTimeEqual(presented, secret);
}

/** Parse a webhook delivery body into an update, or `undefined` if malformed. */
export function parseUpdate(body: string): TelegramUpdate | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as { update_id?: unknown };
  if (typeof candidate.update_id !== 'number') return undefined;
  return parsed as TelegramUpdate;
}
