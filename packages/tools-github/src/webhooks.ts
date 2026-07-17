/**
 * Webhook signature verification.
 *
 * GitHub signs every webhook delivery with an HMAC-SHA256 over the raw body,
 * keyed on a secret only GitHub and the receiver know, in the
 * `X-Hub-Signature-256` header. Verifying it is the *entire* security of a webhook
 * endpoint: without it, anyone who learns the URL can POST a forged "a push
 * happened" event and drive whatever the receiver does in response.
 *
 * Two things make this correct rather than nearly-correct, and both are easy to
 * miss:
 *
 * 1. **The raw bytes.** The HMAC is over the body exactly as sent. Verifying a
 *    re-serialised JSON object instead would fail on any whitespace or key-order
 *    difference — so this takes the raw string, and a caller must not parse
 *    before verifying.
 * 2. **A constant-time compare.** A byte-by-byte `===` leaks, through its timing,
 *    how many leading bytes matched, which is enough to forge a signature one byte
 *    at a time. `timingSafeEqual` closes that.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Is this delivery's signature valid for this secret?
 *
 * `rawBody` must be the exact bytes GitHub sent — verify before you parse.
 * `signatureHeader` is the `X-Hub-Signature-256` value, including its `sha256=`
 * prefix. Returns a boolean and never throws on a bad signature; a malformed or
 * absent header is simply invalid.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader?.startsWith('sha256=') !== true) return false;

  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // Length must match before `timingSafeEqual`, which throws on unequal lengths —
  // and a length mismatch is already a definitive "no", so short-circuiting it
  // leaks nothing an attacker does not know (the expected length is fixed).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebhookEvent<T = unknown> {
  /** The event name from `X-GitHub-Event`, e.g. `push`, `pull_request`. */
  readonly name: string;
  /** The delivery GUID from `X-GitHub-Delivery`, for idempotency and tracing. */
  readonly delivery: string;
  readonly payload: T;
}

export interface WebhookHeaders {
  readonly 'x-github-event'?: string;
  readonly 'x-github-delivery'?: string;
  readonly 'x-hub-signature-256'?: string;
}

/**
 * Verify a delivery and parse it into an event, or throw.
 *
 * The one entry point a webhook handler should use: it verifies the signature
 * against the raw body *first*, and only then parses the JSON — so an unverified
 * payload is never handed to `JSON.parse`, let alone to application logic. Throws
 * on a bad signature, a missing event name, or unparseable JSON.
 */
export function parseWebhook<T = unknown>(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
): WebhookEvent<T> {
  if (!verifyWebhookSignature(rawBody, headers['x-hub-signature-256'], secret)) {
    throw new Error('webhook signature verification failed');
  }
  const name = headers['x-github-event'];
  if (name === undefined || name === '') {
    throw new Error('webhook is missing the X-GitHub-Event header');
  }
  let payload: T;
  try {
    payload = JSON.parse(rawBody) as T;
  } catch (err) {
    throw new Error('webhook body is not valid JSON', { cause: err });
  }
  return { name, delivery: headers['x-github-delivery'] ?? '', payload };
}
