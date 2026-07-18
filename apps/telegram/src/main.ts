/**
 * The entrypoint — the one impure module. Load config from the environment,
 * construct the real ports (Ollama model, rooted filesystem, guarded HTTP,
 * optional allowlisted shell), wire the agent, and run the Telegram long-poll
 * loop until a signal aborts it. Everything decision-making lives in the pure
 * builders; this binds them to the process (and is excluded from unit coverage
 * for that reason — it is exercised by running the bot).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfigFromEnv } from '@hermes/config';
import { systemClock } from '@hermes/kernel';
import { StructuredLogger, consoleSink } from '@hermes/logger';
import { OpenAIChatModel, OpenAIClient } from '@hermes/provider-openai';
import { Scheduler } from '@hermes/scheduler';
import { NodeFileSystem, rooted } from '@hermes/tools-fs';
import { FetchHttpClient, guarded } from '@hermes/tools-http';
import { NodeShellExecutor, allowlisted } from '@hermes/tools-shell';
import { TelegramBot, TelegramClient } from '@hermes/telegram';
import type { MemoryAdapter } from '@hermes/agent';
import { buildAgentRuntime } from './agent.js';
import { formatBriefing, formatCiAlert, isCiFailing } from './briefing.js';
import { registerHandlers } from './bot.js';
import { telegramSchema } from './config.js';
import { toolExecutor } from './executor.js';
import { MemoryStore, type EmbedFn } from './memory-store.js';
import { DOCS_SUBJECT, ingestDocs } from './rag.js';
import { buildTeamRuntime } from './team.js';
import { buildTools } from './tools.js';
import { lenientWorkspaceFs } from './workspace-fs.js';

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
  // Resolve the workspace to an ABSOLUTE path first: `rooted` normalises its
  // root against the filesystem root, so a relative "./hermes-workspace" would
  // become "/hermes-workspace" (unwritable) rather than a dir under the cwd.
  // Create it up front so the first file tool does not fail on a missing dir.
  const workspaceDir = path.resolve(config.workspaceDir);
  const disk = new NodeFileSystem();
  await disk.mkdir(workspaceDir, true);
  // rooted enforces the boundary; lenientWorkspaceFs forgives the paths a small
  // model actually sends (absolute, doubled name, no leading mkdir).
  const fs = lenientWorkspaceFs(rooted(disk, workspaceDir), workspaceDir);
  const http = guarded(new FetchHttpClient(), { policy: { blockPrivate: true } });
  const shell = config.enableShell
    ? allowlisted(
        new NodeShellExecutor({
          cwd: workspaceDir,
          timeoutMs: config.shellTimeoutMs,
          maxOutputBytes: config.shellMaxOutputBytes,
        }),
        config.shellAllowlist,
      )
    : undefined;

  const tools = buildTools({ fs, http, ...(shell === undefined ? {} : { shell }) });
  const executor = toolExecutor(tools, { logger });

  // Persistent memory: embed text with Ollama's native /api/embed and store it
  // under the data dir (outside the model-writable workspace).
  const ollamaRoot = config.ollamaBaseUrl.replace(/\/v1\/?$/, '');
  const embed: EmbedFn = async (texts) => {
    const res = await fetch(`${ollamaRoot}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.embeddingModel, input: texts }),
    });
    if (!res.ok) throw new Error(`embed failed: ${String(res.status)}`);
    const json = (await res.json()) as { embeddings?: readonly (readonly number[])[] };
    return json.embeddings ?? [];
  };
  const memory = await MemoryStore.load({
    embed,
    filePath: path.resolve(config.dataDir, 'memory.json'),
    clock: systemClock,
  });

  const runtimeDeps = {
    model,
    executor,
    maxTurns: config.maxTurns,
    logger,
    clock: systemClock,
    // Recall the chat's own memories plus any ingested documents.
    memory: memory.asMemoryAdapter([DOCS_SUBJECT]) as unknown as MemoryAdapter,
    recall: config.memoryRecall,
  };
  const runtime = config.enableTeam
    ? buildTeamRuntime(runtimeDeps)
    : buildAgentRuntime(runtimeDeps);

  // /ingest reads the docs folder, chunks + embeds each file into memory.
  const docsDir = path.resolve(config.docsDir);
  const onIngest = async (): Promise<string> => {
    await fsp.mkdir(docsDir, { recursive: true });
    const names = await fsp.readdir(docsDir);
    const docs: { name: string; content: string }[] = [];
    for (const name of names) {
      const full = path.join(docsDir, name);
      if ((await fsp.stat(full)).isFile()) {
        docs.push({ name, content: await fsp.readFile(full, 'utf8') });
      }
    }
    if (docs.length === 0)
      return `No files found in ${config.docsDir}. Add some and /ingest again.`;
    const chunks = await ingestDocs(memory, docs);
    return `Ingested ${String(docs.length)} file(s) into ${String(chunks)} chunks. Ask me about them!`;
  };

  // A photo: download it via the raw Telegram Bot API and describe it with the
  // Ollama vision model (bypassing @hermes/model, which is text-only).
  const token = config.telegramBotToken;
  const onPhoto = async (fileId: string, prompt: string): Promise<string> => {
    const meta = (await (
      await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    ).json()) as { result?: { file_path?: string } };
    const filePath = meta.result?.file_path;
    if (filePath === undefined) throw new Error('Telegram getFile returned no path');
    const bytes = await (
      await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
    ).arrayBuffer();
    const image = Buffer.from(bytes).toString('base64');
    const res = await fetch(`${ollamaRoot}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.visionModel,
        stream: false,
        messages: [{ role: 'user', content: prompt, images: [image] }],
      }),
    });
    if (!res.ok) throw new Error(`vision request failed: ${String(res.status)}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? '(the vision model returned nothing)';
  };

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
  registerHandlers(bot, {
    runtime,
    logger,
    remember: (subject, text) =>
      memory.remember({ subject, kind: 'episode', content: text }),
    onIngest,
    ...(config.visionModel === '' ? {} : { onPhoto }),
  });

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

  // Scheduled pushes: a morning briefing, and (if CI_REPO is set) a CI watcher.
  const scheduler = new Scheduler<{ kind: 'briefing' | 'ci' }>();
  if (config.enableBriefing) {
    scheduler.add(
      {
        id: 'briefing',
        trigger: { kind: 'cron', expression: config.briefingCron },
        payload: { kind: 'briefing' },
      },
      Date.now(),
    );
  }
  if (config.ciRepo !== '') {
    scheduler.add(
      {
        id: 'ci',
        trigger: { kind: 'cron', expression: config.ciCron },
        payload: { kind: 'ci' },
      },
      Date.now(),
    );
  }

  const fetchJson = async <T>(target: string): Promise<T> => {
    const res = await fetch(target, { headers: { 'user-agent': 'hermes-telegram' } });
    if (!res.ok) throw new Error(`GET ${target} -> ${String(res.status)}`);
    return (await res.json()) as T;
  };
  const scheduledTargets = (): number[] =>
    config.briefingChatId !== undefined
      ? [config.briefingChatId]
      : memory.subjects().map(Number);
  const sendAll = async (text: string): Promise<void> => {
    for (const chatId of scheduledTargets()) await client.sendMessage({ chatId, text });
  };
  const runBriefing = async (): Promise<void> => {
    const weather = await fetchJson<{
      current: { temperature_2m: number };
      daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
    }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${String(config.briefingLat)}` +
        `&longitude=${String(config.briefingLon)}&current=temperature_2m` +
        `&daily=temperature_2m_max,temperature_2m_min&timezone=auto`,
    );
    const ids = await fetchJson<number[]>(
      'https://hacker-news.firebaseio.com/v0/topstories.json',
    );
    const items = await Promise.all(
      ids
        .slice(0, 5)
        .map((id) =>
          fetchJson<{ title?: string }>(
            `https://hacker-news.firebaseio.com/v0/item/${String(id)}.json`,
          ),
        ),
    );
    await sendAll(
      formatBriefing({
        city: config.briefingCity,
        date: new Date().toDateString(),
        weather: {
          tempNow: weather.current.temperature_2m,
          tempMax: weather.daily.temperature_2m_max[0] ?? 0,
          tempMin: weather.daily.temperature_2m_min[0] ?? 0,
        },
        headlines: items.map((item) => item.title ?? '(untitled)'),
      }),
    );
  };
  const runCi = async (): Promise<void> => {
    const data = await fetchJson<{
      workflow_runs?: { conclusion: string | null; html_url: string }[];
    }>(
      `https://api.github.com/repos/${config.ciRepo}/actions/runs` +
        `?branch=${config.ciBranch}&per_page=1`,
    );
    const run = data.workflow_runs?.[0];
    if (run !== undefined && isCiFailing(run.conclusion)) {
      await sendAll(
        formatCiAlert({
          repo: config.ciRepo,
          branch: config.ciBranch,
          conclusion: run.conclusion,
          url: run.html_url,
        }),
      );
    }
  };
  const timer = setInterval(() => {
    for (const job of scheduler.poll(Date.now())) {
      const work = job.payload.kind === 'briefing' ? runBriefing() : runCi();
      work.catch((thrown: unknown) => {
        logger.warn('scheduled job failed', {
          id: job.id,
          error: (thrown as Error).message,
        });
      });
    }
  }, 60_000);
  controller.signal.addEventListener('abort', () => {
    clearInterval(timer);
  });

  logger.info('bot ready', {
    bot: me.username ?? me.first_name,
    model: config.ollamaModel,
    tools: tools.length,
    shell: config.enableShell,
    briefing: config.enableBriefing,
    ciWatch: config.ciRepo !== '' ? config.ciRepo : 'off',
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
