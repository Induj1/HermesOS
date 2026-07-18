/**
 * The fake server's own robustness — the handler's edge cases.
 */

import type { HttpRequest } from '@hermes/tools-http';
import { describe, expect, it } from 'vitest';
import { FakeTelegramServer } from '../src/fake.js';

const req = (url: string, body?: string): HttpRequest =>
  body === undefined ? { url, method: 'POST' } : { url, method: 'POST', body };

function parse(bodyText: string): { ok: boolean; error_code?: number } {
  return JSON.parse(bodyText) as { ok: boolean; error_code?: number };
}

describe('FakeTelegramServer.handler', () => {
  const server = new FakeTelegramServer({ token: 'tok' });

  it('404s a URL that is not a bot method', () => {
    const res = server.handler(req('https://api.telegram.org/nonsense'));
    expect(res.status).toBe(404);
  });

  it('404s an unknown method', () => {
    const res = server.handler(req('https://api.telegram.org/bottok/deleteChat', '{}'));
    expect(res.status).toBe(404);
    expect(parse(res.body ?? '').ok).toBe(false);
  });

  it('tolerates a non-object JSON body', () => {
    const res = server.handler(
      req('https://api.telegram.org/bottok/getUpdates', '123'),
    );
    expect(res.status).toBe(200);
  });

  it('tolerates an invalid JSON body', () => {
    const res = server.handler(
      req('https://api.telegram.org/bottok/getUpdates', 'not json'),
    );
    expect(res.status).toBe(200);
  });

  it('defaults chat_id and text when sendMessage params are the wrong type', () => {
    const res = server.handler(
      req('https://api.telegram.org/bottok/sendMessage', '{"chat_id":"x","text":5}'),
    );
    const result = (
      JSON.parse(res.body ?? '') as { result: { chat: { id: number }; text: string } }
    ).result;
    expect(result.chat.id).toBe(0);
    expect(result.text).toBe('');
  });
});
