/**
 * @hermes/telegram — A Telegram Bot API client, dispatcher, and fake server.
 *
 * ```ts
 * import { FakeHttpClient } from '@hermes/tools-http';
 * import { TelegramBot, TelegramClient } from '@hermes/telegram';
 *
 * const client = new TelegramClient({ token, http: new FetchHttpClient() });
 * const bot = new TelegramBot({ client, username: 'hermes_bot' });
 *
 * bot.command('start', (ctx) => ctx.reply('Hello!'));
 * bot.onText((ctx) => ctx.reply(`echo: ${ctx.text}`));
 *
 * const controller = new AbortController();
 * await bot.run(systemClock, { signal: controller.signal, intervalMs: 1000 });
 * ```
 *
 * The client speaks the Bot API over an injected `HttpClient`; `FakeTelegramServer`
 * backs a `FakeHttpClient` for deterministic tests. Webhook delivery is verified
 * with `verifyWebhook` (constant-time secret-token check).
 */

export type {
  ApiResponse,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './api.js';

export { TelegramError } from './errors.js';

export {
  TelegramClient,
  type GetUpdatesParams,
  type SendMessageParams,
  type TelegramClientOptions,
} from './client.js';

export {
  TelegramBot,
  type BotOptions,
  type Handler,
  type MessageContext,
} from './bot.js';

export {
  SECRET_TOKEN_HEADER,
  parseUpdate,
  verifyWebhook,
  type Headers,
} from './webhook.js';

export { FakeTelegramServer, type FakeServerOptions } from './fake.js';
