/**
 * The bot — command routing, text fallback, offset tracking, and the poll loop.
 */

import { TestClock } from '@hermes/kernel';
import { FakeHttpClient } from '@hermes/tools-http';
import { describe, expect, it } from 'vitest';
import { TelegramBot } from '../src/bot.js';
import { TelegramClient } from '../src/client.js';
import { FakeTelegramServer } from '../src/fake.js';

function wired(username?: string) {
  const server = new FakeTelegramServer({ token: 'tok' });
  const http = new FakeHttpClient({ handle: server.handler });
  const client = new TelegramClient({ token: 'tok', http });
  const bot = new TelegramBot(
    username === undefined ? { client } : { client, username },
  );
  return { server, client, bot };
}

describe('command routing', () => {
  it('routes /command to its handler with parsed args', async () => {
    const { server, bot } = wired();
    const seen: string[][] = [];
    bot.command('echo', (ctx) => {
      seen.push([ctx.command ?? '', ...ctx.args]);
    });
    server.enqueueMessage('/echo a b c');
    const handled = await bot.poll();
    expect(handled).toBe(1);
    expect(seen).toEqual([['echo', 'a', 'b', 'c']]);
  });

  it('replies in the same chat', async () => {
    const { server, bot } = wired();
    bot.command('start', (ctx) => ctx.reply('welcome'));
    server.enqueueMessage('/start', { chatId: 555 });
    await bot.poll();
    expect(server.sent[0]?.text).toBe('welcome');
    expect(server.sent[0]?.chat.id).toBe(555);
  });

  it('strips @username and ignores commands addressed to another bot', async () => {
    const { server, bot } = wired('hermes_bot');
    const hits: string[] = [];
    bot.command('ping', (ctx) => {
      hits.push(ctx.command ?? '');
    });
    server.enqueueMessage('/ping@hermes_bot');
    server.enqueueMessage('/ping@other_bot');
    const handled = await bot.poll();
    expect(handled).toBe(1);
    expect(hits).toEqual(['ping']);
  });

  it('falls back to onText for non-command and unknown-command text', async () => {
    const { server, bot } = wired();
    const texts: string[] = [];
    bot.command('known', () => undefined);
    bot.onText((ctx) => {
      texts.push(ctx.text);
    });
    server.enqueueMessage('just chatting');
    server.enqueueMessage('/unknown thing');
    const handled = await bot.poll();
    expect(handled).toBe(2);
    expect(texts).toEqual(['just chatting', '/unknown thing']);
  });

  it('leaves an unhandled message unhandled but still acknowledged', async () => {
    const { server, bot } = wired();
    bot.command('known', () => undefined);
    server.enqueueMessage('no handler for this');
    expect(await bot.poll()).toBe(0);
    // Offset advanced, so a second poll returns nothing to reprocess.
    expect(await bot.poll()).toBe(0);
  });
});

describe('offset tracking', () => {
  it('does not redeliver an update across polls', async () => {
    const { server, bot } = wired();
    let count = 0;
    bot.onText(() => {
      count += 1;
    });
    server.enqueueMessage('first');
    await bot.poll();
    server.enqueueMessage('second');
    await bot.poll();
    expect(count).toBe(2); // not 3 — 'first' was not reprocessed
  });

  it('ignores updates without a message', async () => {
    const { bot } = wired();
    const handled = await bot.processUpdates([{ update_id: 5 }]);
    expect(handled).toBe(0);
  });

  it('handles a message with no text (empty text, not a command)', async () => {
    const { bot } = wired();
    const seen: string[] = [];
    bot.onText((ctx) => {
      seen.push(ctx.text);
    });
    const handled = await bot.processUpdates([
      {
        update_id: 9,
        message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 },
      },
    ]);
    expect(handled).toBe(1);
    expect(seen).toEqual(['']);
  });

  it('treats a lone "/" as text, not a command', async () => {
    const { server, bot } = wired();
    const texts: string[] = [];
    bot.command('x', () => undefined);
    bot.onText((ctx) => {
      texts.push(ctx.text);
    });
    server.enqueueMessage('/   ');
    expect(await bot.poll()).toBe(1);
    expect(texts).toEqual(['/   ']);
  });
});

describe('run loop', () => {
  it('polls until the signal aborts', async () => {
    const { server, bot } = wired();
    const replies: string[] = [];
    bot.onText((ctx) => {
      replies.push(ctx.text);
    });
    server.enqueueMessage('hello');

    const controller = new AbortController();
    const clock = new TestClock();
    const loop = bot.run(clock, { signal: controller.signal, intervalMs: 1000 });

    // Let the first poll run, then abort during the inter-poll sleep.
    await Promise.resolve();
    controller.abort();
    await loop;

    expect(replies).toEqual(['hello']);
  });

  it('keeps polling across a completed inter-poll sleep', async () => {
    const { server, bot } = wired();
    const replies: string[] = [];
    bot.onText((ctx) => {
      replies.push(ctx.text);
    });
    // Flush enough microtasks for a poll (an async HTTP round-trip) to settle.
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };
    const controller = new AbortController();
    const clock = new TestClock();
    server.enqueueMessage('first');
    const loop = bot.run(clock, { signal: controller.signal, intervalMs: 1000 });

    await flush(); // first poll completes; loop parks on the inter-poll sleep
    server.enqueueMessage('second');
    await clock.advance(1000); // sleep fires; loop polls again
    await flush(); // second poll completes
    controller.abort();
    await loop;

    expect(replies).toContain('first');
    expect(replies).toContain('second');
  });

  it('exits immediately when the signal is already aborted', async () => {
    const { bot } = wired();
    const controller = new AbortController();
    controller.abort();
    await bot.run(new TestClock(), { signal: controller.signal });
    // No throw, returns promptly.
    expect(true).toBe(true);
  });
});
