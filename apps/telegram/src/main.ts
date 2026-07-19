/**
 * The entrypoint — the one impure module. Load config from the environment,
 * construct the real ports (Ollama model, rooted filesystem, guarded HTTP,
 * optional allowlisted shell), wire the agent, and run the Telegram long-poll
 * loop until a signal aborts it. Everything decision-making lives in the pure
 * builders; this binds them to the process (and is excluded from unit coverage
 * for that reason — it is exercised by running the bot).
 */

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
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
import {
  formatBriefing,
  formatCiAlert,
  formatStandup,
  isCiFailing,
} from './briefing.js';
import { registerHandlers } from './bot.js';
import { telegramSchema } from './config.js';
import { ConversationHistory } from './conversation.js';
import { renderDashboard } from './dashboard.js';
import { toolExecutor } from './executor.js';
import { MemoryStore, type EmbedFn } from './memory-store.js';
import { DOCS_SUBJECT, htmlToText, ingestDocs } from './rag.js';
import { humanDuration, type Reminder } from './reminders.js';
import { guardedShell } from './shell-guard.js';
import { buildTeamRuntime } from './team.js';
import { buildTools } from './tools.js';
import { lenientWorkspaceFs } from './workspace-fs.js';

const execFileAsync = promisify(execFile);

/** Scheduled job payloads driven by the Scheduler poll loop. */
type Job =
  | { readonly kind: 'briefing' | 'ci' | 'standup' }
  | {
      readonly kind: 'reminder';
      readonly id: string;
      readonly chatId: number;
      readonly message: string;
    };

async function loadReminders(file: string): Promise<Reminder[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Reminder[]) : [];
  } catch {
    return [];
  }
}

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
  const deny =
    config.shellDeny.length > 0
      ? config.shellDeny.map((p) => new RegExp(p, 'i'))
      : undefined;
  const shell = config.enableShell
    ? guardedShell(
        allowlisted(
          new NodeShellExecutor({
            cwd: workspaceDir,
            timeoutMs: config.shellTimeoutMs,
            maxOutputBytes: config.shellMaxOutputBytes,
          }),
          config.shellAllowlist,
        ),
        deny,
      )
    : undefined;

  // Headless-browser port (Playwright), lazily imported so the app boots without
  // a browser installed. Reads the rendered text of a page.
  const browse = async (url: string, maxChars: number): Promise<string> => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const text = await page.innerText('body');
      return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    } finally {
      await browser.close();
    }
  };

  // Render an HTML document to a PDF in the workspace (via headless Chromium).
  const renderPdf = async (html: string, filename: string): Promise<string> => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      const safe = path.basename(
        filename.endsWith('.pdf') ? filename : `${filename}.pdf`,
      );
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await fs.writeFile(safe, Buffer.from(pdf));
      return safe;
    } finally {
      await browser.close();
    }
  };

  const tools = buildTools({
    fs,
    http,
    githubToken: config.githubToken,
    ...(shell === undefined ? {} : { shell }),
    ...(config.enableBrowser ? { browse, renderPdf } : {}),
  });
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

  // The scheduler drives briefings, the CI watcher, standups, and reminders.
  // Reminders persist to a file and are re-armed on start.
  const scheduler = new Scheduler<Job>();
  const remindersFile = path.resolve(config.dataDir, 'reminders.json');
  let reminders = await loadReminders(remindersFile);
  const saveReminders = (): Promise<void> =>
    fsp.writeFile(remindersFile, JSON.stringify(reminders), 'utf8');

  const onRemind = async (
    chatId: number,
    ms: number,
    message: string,
  ): Promise<string> => {
    const id = `rem_${String(Date.now())}_${String(reminders.length)}`;
    const reminder: Reminder = { id, chatId, atMs: Date.now() + ms, message };
    reminders.push(reminder);
    await saveReminders();
    scheduler.add(
      {
        id,
        trigger: { kind: 'once', atMs: reminder.atMs },
        payload: { kind: 'reminder', ...reminder },
      },
      Date.now(),
    );
    return `⏰ Reminder set for ${humanDuration(ms)} from now: "${message}"`;
  };

  // /ingest reads the docs folder recursively, chunks + embeds each file.
  const docsDir = path.resolve(config.docsDir);
  const walkFiles = async (dir: string): Promise<string[]> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walkFiles(full)));
      else if (entry.isFile()) files.push(full);
    }
    return files;
  };
  const onIngest = async (): Promise<string> => {
    await fsp.mkdir(docsDir, { recursive: true });
    const files = await walkFiles(docsDir);
    const docs: { name: string; content: string }[] = [];
    for (const full of files) {
      const name = path.relative(docsDir, full); // relative path, for citation
      if (name.toLowerCase().endsWith('.pdf')) {
        // pdftotext (poppler) extracts text; "-" writes to stdout.
        const { stdout } = await execFileAsync('pdftotext', [full, '-']);
        docs.push({ name, content: stdout });
      } else {
        docs.push({ name, content: await fsp.readFile(full, 'utf8') });
      }
    }
    if (docs.length === 0)
      return `No files found in ${config.docsDir}. Add some and /ingest again.`;
    const chunks = await ingestDocs(memory, docs);
    return `Ingested ${String(docs.length)} file(s) into ${String(chunks)} chunks. Ask me about them!`;
  };

  // /ingesturl fetches a web page, strips it to text, and ingests it.
  const onIngestUrl = async (url: string): Promise<string> => {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (hermes-telegram)' },
    });
    if (!res.ok) throw new Error(`fetch failed: ${String(res.status)}`);
    const text = htmlToText(await res.text());
    const chunks = await ingestDocs(memory, [{ name: url, content: text }]);
    return `Ingested ${url} into ${String(chunks)} chunks. Ask me about it!`;
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

  // A voice note: download the OGG, convert to 16kHz WAV with ffmpeg, and
  // transcribe it with whisper.cpp. Local, offline, no API.
  const onVoice = async (fileId: string): Promise<string> => {
    const meta = (await (
      await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    ).json()) as { result?: { file_path?: string } };
    const filePath = meta.result?.file_path;
    if (filePath === undefined) throw new Error('Telegram getFile returned no path');
    const bytes = await (
      await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
    ).arrayBuffer();

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-voice-'));
    try {
      const oga = path.join(dir, 'in.oga');
      const wav = path.join(dir, 'out.wav');
      await fsp.writeFile(oga, Buffer.from(bytes));
      await execFileAsync('ffmpeg', ['-y', '-i', oga, '-ar', '16000', '-ac', '1', wav]);
      const { stdout } = await execFileAsync(config.whisperCli, [
        '-m',
        config.whisperModel,
        '-f',
        wav,
        '-nt',
      ]);
      return stdout.trim();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // Speak a reply back: synthesize audio, ffmpeg to OGG/Opus, upload via sendVoice.
  const speak = async (chatId: number, text: string): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-tts-'));
    try {
      const clipped = text.slice(0, 800);
      const raw = path.join(dir, config.ttsMode === 'piper' ? 'out.wav' : 'out.aiff');
      const ogg = path.join(dir, 'out.ogg');
      if (config.ttsMode === 'piper') {
        // Piper reads text from stdin; keep the user text out of the shell string.
        const txt = path.join(dir, 'in.txt');
        await fsp.writeFile(txt, clipped);
        await execFileAsync('sh', [
          '-c',
          'exec "$1" -m "$2" -f "$3" < "$4"',
          'sh',
          config.piperBin,
          config.piperModel,
          raw,
          txt,
        ]);
      } else {
        await execFileAsync(config.ttsCommand, ['-o', raw, clipped]);
      }
      await execFileAsync('ffmpeg', ['-y', '-i', raw, '-c:a', 'libopus', ogg]);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([await fsp.readFile(ogg)]), 'reply.ogg');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendVoice failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // Upload an image buffer to a chat via the raw Telegram sendPhoto API.
  const sendPhoto = async (
    chatId: number,
    bytes: Buffer,
    name: string,
  ): Promise<void> => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([bytes]), name);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`sendPhoto failed: ${String(res.status)}`);
  };

  // /get: read a workspace file (confined by the rooted fs) and send it.
  const onGet = async (filePath: string, chatId: number): Promise<void> => {
    const bytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([Buffer.from(bytes)]), path.basename(filePath));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`sendDocument failed: ${String(res.status)}`);
  };

  // /screenshot: render a page in headless Chromium and send a PNG.
  const onScreenshot = async (url: string, chatId: number): Promise<void> => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      const png = await page.screenshot();
      await sendPhoto(chatId, Buffer.from(png), 'screenshot.png');
    } finally {
      await browser.close();
    }
  };

  // /imagine: generate an image locally with Stable Diffusion and send it.
  const onImagine = async (prompt: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-img-'));
    try {
      const out = path.join(dir, 'image.png');
      await execFileAsync(config.imagegenPython, [config.imagegenScript, prompt, out], {
        timeout: 300_000,
      });
      await sendPhoto(chatId, await fsp.readFile(out), 'image.png');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // Photo + transform caption: download it, run SD img2img, send the result.
  const onImg2img = async (
    fileId: string,
    prompt: string,
    chatId: number,
  ): Promise<void> => {
    const meta = (await (
      await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    ).json()) as { result?: { file_path?: string } };
    const filePath = meta.result?.file_path;
    if (filePath === undefined) throw new Error('Telegram getFile returned no path');
    const bytes = await (
      await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
    ).arrayBuffer();

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-i2i-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'out.png');
      await fsp.writeFile(inPath, Buffer.from(bytes));
      await execFileAsync(
        config.imagegenPython,
        [config.img2imgScript, prompt, inPath, out],
        {
          timeout: 300_000,
        },
      );
      await sendPhoto(chatId, await fsp.readFile(out), 'image.png');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // /music: generate a clip with MusicGen, convert to Opus, send as a voice note.
  const onMusic = async (prompt: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-mus-'));
    try {
      const wav = path.join(dir, 'music.wav');
      const ogg = path.join(dir, 'music.ogg');
      await execFileAsync(config.imagegenPython, [config.musicScript, prompt, wav], {
        timeout: 300_000,
      });
      await execFileAsync('ffmpeg', ['-y', '-i', wav, '-c:a', 'libopus', ogg]);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([await fsp.readFile(ogg)]), 'music.ogg');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendVoice failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
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
    onIngestUrl,
    onRemind,
    onGet,
    ...(config.enableImagegen &&
    config.imagegenPython !== '' &&
    config.musicScript !== ''
      ? { onMusic }
      : {}),
    history: new ConversationHistory(),
    allowedChatIds: config.allowedChatIds,
    ...(config.visionModel === '' ? {} : { onPhoto }),
    ...(config.whisperModel === '' ? {} : { onVoice }),
    ...(config.enableImagegen &&
    config.imagegenPython !== '' &&
    config.img2imgScript !== ''
      ? { onImg2img }
      : {}),
    ...(config.enableVoiceReplies ? { speak } : {}),
    ...(config.enableBrowser ? { onScreenshot } : {}),
    ...(config.enableImagegen &&
    config.imagegenPython !== '' &&
    config.imagegenScript !== ''
      ? { onImagine }
      : {}),
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

  // Optional read-only dashboard on loopback.
  if (config.dashboardPort > 0) {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        renderDashboard({
          bot: me.username ?? me.first_name,
          model: config.ollamaModel,
          memoryCount: memory.size,
          subjects: memory.subjects(),
          reminders: reminders.map((r) => ({
            message: r.message,
            inMinutes: (r.atMs - Date.now()) / 60_000,
          })),
          features: [
            'agent',
            'team',
            'memory',
            'RAG',
            'vision',
            'voice',
            'img2img',
            'browser',
            'imagegen',
            'music',
            'github',
            'briefing',
            'standup',
            'reminders',
          ],
        }),
      );
    });
    server.listen(config.dashboardPort, '127.0.0.1', () => {
      logger.info('dashboard', {
        url: `http://127.0.0.1:${String(config.dashboardPort)}`,
      });
    });
    controller.signal.addEventListener('abort', () => {
      server.close();
    });
  }

  // Scheduled pushes: a morning briefing, and (if CI_REPO is set) a CI watcher.
  // Re-arm reminders persisted from before a restart (overdue ones fire soon).
  for (const reminder of reminders) {
    scheduler.add(
      {
        id: reminder.id,
        trigger: { kind: 'once', atMs: reminder.atMs },
        payload: { kind: 'reminder', ...reminder },
      },
      Date.now(),
    );
  }
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
  if (config.enableStandup) {
    scheduler.add(
      {
        id: 'standup',
        trigger: { kind: 'cron', expression: config.standupCron },
        payload: { kind: 'standup' },
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
  const runStandup = async (): Promise<void> => {
    const repos = await Promise.all(
      config.standupRepos.map(async (repo) => {
        try {
          const { stdout } = await execFileAsync('git', [
            '-C',
            repo,
            'log',
            '--since=1 day ago',
            '--pretty=format:%s',
          ]);
          const commits = stdout.split('\n').filter((line) => line.trim() !== '');
          return { name: path.basename(repo), commits };
        } catch {
          return { name: path.basename(repo), commits: [] };
        }
      }),
    );
    await sendAll(formatStandup(repos, new Date().toDateString()));
  };

  const runReminder = async (payload: {
    id: string;
    chatId: number;
    message: string;
  }): Promise<void> => {
    await client.sendMessage({ chatId: payload.chatId, text: `⏰ ${payload.message}` });
    reminders = reminders.filter((r) => r.id !== payload.id);
    await saveReminders();
  };
  const runJob = (payload: Job): Promise<void> => {
    switch (payload.kind) {
      case 'briefing':
        return runBriefing();
      case 'ci':
        return runCi();
      case 'standup':
        return runStandup();
      case 'reminder':
        return runReminder(payload);
    }
  };
  const timer = setInterval(() => {
    for (const job of scheduler.poll(Date.now())) {
      const work = runJob(job.payload);
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
