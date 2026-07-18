/**
 * Webhook verification and update parsing.
 */

import { describe, expect, it } from 'vitest';
import { SECRET_TOKEN_HEADER, parseUpdate, verifyWebhook } from '../src/webhook.js';

describe('verifyWebhook', () => {
  it('accepts a matching secret token, case-insensitive header', () => {
    expect(verifyWebhook({ [SECRET_TOKEN_HEADER]: 'sekret' }, 'sekret')).toBe(true);
    expect(
      verifyWebhook({ 'X-Telegram-Bot-Api-Secret-Token': 'sekret' }, 'sekret'),
    ).toBe(true);
  });

  it('rejects a wrong or missing token', () => {
    expect(verifyWebhook({ [SECRET_TOKEN_HEADER]: 'nope' }, 'sekret')).toBe(false);
    expect(
      verifyWebhook({ [SECRET_TOKEN_HEADER]: 'longer-than-secret' }, 'sekret'),
    ).toBe(false);
    expect(verifyWebhook({}, 'sekret')).toBe(false);
  });
});

describe('parseUpdate', () => {
  it('parses a well-formed update', () => {
    const update = parseUpdate('{"update_id":7,"message":{"message_id":1}}');
    expect(update?.update_id).toBe(7);
  });

  it('returns undefined for malformed or non-update bodies', () => {
    expect(parseUpdate('not json')).toBeUndefined();
    expect(parseUpdate('null')).toBeUndefined();
    expect(parseUpdate('123')).toBeUndefined();
    expect(parseUpdate('{"no":"update_id"}')).toBeUndefined();
  });
});
