/**
 * The client — Bot API methods over a FakeHttpClient driving the fake server.
 */

import { FakeHttpClient, type HttpClient } from '@hermes/tools-http';
import { describe, expect, it } from 'vitest';
import { TelegramClient } from '../src/client.js';
import { TelegramError } from '../src/errors.js';
import { FakeTelegramServer } from '../src/fake.js';

/** Await a promise expected to reject, returning the TelegramError. */
async function rejection(promise: Promise<unknown>): Promise<TelegramError> {
  try {
    await promise;
    throw new Error('expected the call to reject');
  } catch (error) {
    return error as TelegramError;
  }
}

function wired(token = 'tok') {
  const server = new FakeTelegramServer({ token });
  const http = new FakeHttpClient({ handle: server.handler });
  const client = new TelegramClient({ token, http });
  return { server, http, client };
}

describe('getMe', () => {
  it('returns the bot identity', async () => {
    const { client } = wired();
    const me = await client.getMe();
    expect(me.is_bot).toBe(true);
    expect(me.username).toBe('hermes_bot');
  });
});

describe('sendMessage', () => {
  it('sends text and records it on the server', async () => {
    const { client, server } = wired();
    const message = await client.sendMessage({ chatId: 42, text: 'hi' });
    expect(message.text).toBe('hi');
    expect(message.chat.id).toBe(42);
    expect(server.sent).toHaveLength(1);
  });

  it('includes optional parse_mode and reply target in the request', async () => {
    const { client, http } = wired();
    await client.sendMessage({
      chatId: 1,
      text: 't',
      parseMode: 'HTML',
      replyToMessageId: 7,
    });
    const body = JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['parse_mode']).toBe('HTML');
    expect(body['reply_to_message_id']).toBe(7);
  });
});

describe('getUpdates', () => {
  it('returns queued updates and honours the offset', async () => {
    const { client, server } = wired();
    server.enqueueMessage('one');
    const second = server.enqueueMessage('two');

    const all = await client.getUpdates();
    expect(all).toHaveLength(2);

    const afterFirst = await client.getUpdates({ offset: second.update_id });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.message?.text).toBe('two');
  });

  it('passes limit and timeout through', async () => {
    const { client, http } = wired();
    await client.getUpdates({ limit: 5, timeoutSeconds: 30 });
    const body = JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({ limit: 5, timeout: 30 });
  });
});

describe('errors', () => {
  it('raises a TelegramError with the API code on a bad token', async () => {
    const server = new FakeTelegramServer({ token: 'right' });
    const http = new FakeHttpClient({ handle: server.handler });
    const client = new TelegramClient({ token: 'wrong', http });
    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramError);
    expect((await rejection(client.getMe())).code).toBe(401);
  });

  it('never leaks the token in the error message', async () => {
    const server = new FakeTelegramServer({ token: 'right' });
    const http = new FakeHttpClient({ handle: server.handler });
    const client = new TelegramClient({ token: 'super-secret-token', http });
    const error = await rejection(client.getMe());
    expect(error.message).not.toContain('super-secret-token');
  });

  it('wraps a transport failure as a code-0 error', async () => {
    const failing: HttpClient = {
      request: () => Promise.reject(new Error('network down')),
    };
    const client = new TelegramClient({ token: 't', http: failing });
    const error = await rejection(client.getMe());
    expect(error.code).toBe(0);
    expect(error.message).toMatch(/network down/);
  });

  it('wraps a non-Error transport rejection', async () => {
    const failing: HttpClient = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      request: () => Promise.reject('socket hang up'),
    };
    const client = new TelegramClient({ token: 't', http: failing });
    const error = await rejection(client.getMe());
    expect(error.code).toBe(0);
    expect(error.message).toMatch(/socket hang up/);
  });

  it('errors on a non-JSON body', async () => {
    const http: HttpClient = {
      request: () =>
        Promise.resolve({
          status: 200,
          statusText: 'OK',
          headers: {},
          body: 'not json',
          url: 'x',
          truncated: false,
          redirects: 0,
        }),
    };
    const client = new TelegramClient({ token: 't', http });
    await expect(client.getMe()).rejects.toThrow(/non-JSON/);
  });

  it('strips a trailing slash from a custom baseUrl', async () => {
    const { server } = wired();
    const http = new FakeHttpClient({ handle: server.handler });
    const client = new TelegramClient({
      token: 'tok',
      http,
      baseUrl: 'https://api.telegram.org/',
    });
    expect((await client.getMe()).is_bot).toBe(true);
  });
});
