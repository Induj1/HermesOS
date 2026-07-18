# @hermes/telegram

A Telegram Bot API client, long-poll dispatcher, webhook verification, and a
high-fidelity fake server.

- **Design record:** [RFC-0034](../../docs/rfcs/RFC-0034-telegram.md).
- **Depends on:** `@hermes/tools-http` (the `HttpClient`), `@hermes/kernel` (the
  `Clock`).
- **Status:** built and tested against a fake; live use needs a bot token (🔑).

## Usage

```ts
import { systemClock } from '@hermes/kernel';
import { FetchHttpClient } from '@hermes/tools-http';
import { TelegramBot, TelegramClient } from '@hermes/telegram';

const client = new TelegramClient({ token, http: new FetchHttpClient() });
const bot = new TelegramBot({ client, username: 'hermes_bot' });

bot.command('start', (ctx) => ctx.reply('Hello!'));
bot.onText((ctx) => ctx.reply(`echo: ${ctx.text}`));

const controller = new AbortController();
await bot.run(systemClock, { signal: controller.signal, intervalMs: 1000 });
```

Testing is deterministic — no network:

```ts
import { FakeHttpClient } from '@hermes/tools-http';
import { FakeTelegramServer } from '@hermes/telegram';

const server = new FakeTelegramServer({ token: 'tok' });
const http = new FakeHttpClient({ handle: server.handler });
const client = new TelegramClient({ token: 'tok', http });

server.enqueueMessage('/start');
await new TelegramBot({ client }).command('start', (c) => c.reply('hi')).poll();
// server.sent[0].text === 'hi'
```

## Concepts

- **Client.** Typed Bot API over an injected `HttpClient`; errors carry the API
  code and never include the token-bearing URL.
- **Bot.** Routes `/command` (and `/command@thisbot`) to handlers or a text
  fallback; tracks the update offset so nothing is redelivered; `run` drives the
  poll loop off an injected `Clock`.
- **Webhooks.** `verifyWebhook` (constant-time secret-token check) and
  `parseUpdate` for the push alternative.
- **Fake server.** `FakeTelegramServer` behaves like the real API over the wire,
  including the bad-token and unknown-method failures.
