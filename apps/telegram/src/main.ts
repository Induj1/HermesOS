/**
 * The entrypoint — the one impure module. Load config from the environment,
 * construct the real ports (Ollama model, rooted filesystem, guarded HTTP,
 * optional allowlisted shell), wire the agent, and run the Telegram long-poll
 * loop until a signal aborts it. Everything decision-making lives in the pure
 * builders; this binds them to the process (and is excluded from unit coverage
 * for that reason — it is exercised by running the bot).
 */

import process from 'node:process';
import { loadConfigFromEnv } from '@hermes/config';
import { systemClock } from '@hermes/kernel';
import { StructuredLogger, consoleSink } from '@hermes/logger';
import { OpenAIChatModel, OpenAIClient } from '@hermes/provider-openai';
import { NodeFileSystem, rooted } from '@hermes/tools-fs';
import { FetchHttpClient, guarded } from '@hermes/tools-http';
import { NodeShellExecutor, allowlisted } from '@hermes/tools-shell';
import { TelegramBot, TelegramClient } from '@hermes/telegram';
import { buildAgentRuntime } from './agent.js';
import { registerHandlers } from './bot.js';
import { telegramSchema } from './config.js';
import { toolExecutor } from './executor.js';
import { buildTools } from './tools.js';

export async function main(): Promise<void> {
  const config = loadConfigFromEnv(telegramSchema);

  const logger = new StructuredLogger({
    sink: consoleSink(),
    clock: systemClock,
    level: config.logLevel,
    fields: { service: config.serviceName },
  });

  // The model talks to Ollama's OpenAI-compatible endpoint with a bare client:
  // Ollama is keyless, and it lives on loopback, which the `guarded` wrapper
  // (used for the agent's HTTP *tools*, below) would block — as it should for
  // tools, but not for our own model calls.
  const model = new OpenAIChatModel({
    client: new OpenAIClient({
      http: new FetchHttpClient({ timeoutMs: config.modelTimeoutMs }),
      baseUrl: config.ollamaBaseUrl,
      provider: 'ollama',
    }),
    model: config.ollamaModel,
  });

  // Filesystem confined to the workspace; HTTP guarded against SSRF (loopback
  // and private ranges blocked); shell off unless opted in, and then allowlisted.
  // Create the workspace up front so the first file tool does not fail on a
  // missing directory.
  const disk = new NodeFileSystem();
  await disk.mkdir(config.workspaceDir, true);
  const fs = rooted(disk, config.workspaceDir);
  const http = guarded(new FetchHttpClient(), { policy: { blockPrivate: true } });
  const shell = config.enableShell
    ? allowlisted(
        new NodeShellExecutor({ cwd: config.workspaceDir }),
        config.shellAllowlist,
      )
    : undefined;

  const tools = buildTools({ fs, http, ...(shell === undefined ? {} : { shell }) });
  const executor = toolExecutor(tools, { logger });
  const runtime = buildAgentRuntime({
    model,
    executor,
    maxTurns: config.maxTurns,
    logger,
    clock: systemClock,
  });

  // getMe doubles as a token check: a bad token rejects here, before we poll.
  const client = new TelegramClient({
    token: config.telegramBotToken,
    http: new FetchHttpClient(),
  });
  const me = await client.getMe();
  const bot = new TelegramBot({
    client,
    ...(me.username === undefined ? {} : { username: me.username }),
  });
  registerHandlers(bot, { runtime, logger });

  const controller = new AbortController();
  const stop = (signal: string): void => {
    logger.info('shutting down', { signal });
    controller.abort();
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });

  logger.info('bot ready', {
    bot: me.username ?? me.first_name,
    model: config.ollamaModel,
    tools: tools.length,
    shell: config.enableShell,
  });

  await bot.run(systemClock, {
    signal: controller.signal,
    intervalMs: config.pollIntervalMs,
  });
}

main().catch((thrown: unknown) => {
  // Nothing is wired yet, so there is no logger to reach for; a bad token or a
  // missing env var lands here and must be legible on a bare console.
  console.error('hermes-telegram failed to start:', thrown);
  process.exitCode = 1;
});
