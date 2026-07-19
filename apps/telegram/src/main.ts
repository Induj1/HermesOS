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
import { AGENT_NAME, buildAgentRuntime, replyText } from './agent.js';
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
import { DOCS_SUBJECT, REPO_SUBJECT, htmlToText, ingestDocs } from './rag.js';
import { shouldIngestPath } from './repo.js';
import {
  formatApplications,
  type Application,
  type AppStatus,
} from './applications.js';
import { arxivUrl, formatPapers, parseArxiv } from './arxiv.js';
import { formatCves, nvdUrl, parseNvd } from './cve.js';
import { humanDuration, type Reminder } from './reminders.js';
import { localCronToUtc, type ScheduledTask } from './schedules.js';
import { analyzeSecurityHeaders, formatSecurityReport } from './security.js';
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
    }
  | {
      readonly kind: 'task';
      readonly id: string;
      readonly chatId: number;
      readonly prompt: string;
    };

async function loadJsonArray<T>(file: string): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const loadReminders = (file: string): Promise<Reminder[]> =>
  loadJsonArray<Reminder>(file);

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

  // Render a Mermaid diagram to a PNG in the workspace, via headless Chromium and
  // the vendored mermaid.js. Screenshots the rendered SVG at 2x for a crisp image.
  const renderDiagram = async (mermaid: string, filename: string): Promise<string> => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      await page.setContent(
        '<!DOCTYPE html><html><body style="margin:0">' +
          '<div id="out" style="display:inline-block;background:#fff;padding:16px"></div>' +
          '</body></html>',
      );
      await page.addScriptTag({ path: config.mermaidAsset });
      const ok = await page.evaluate(async (src) => {
        const g = globalThis as unknown as {
          mermaid: {
            initialize: (o: unknown) => void;
            render: (id: string, s: string) => Promise<{ svg: string }>;
          };
          document: {
            getElementById: (id: string) => { innerHTML: string } | null;
          };
        };
        g.mermaid.initialize({ startOnLoad: false, theme: 'default' });
        const { svg } = await g.mermaid.render('d', src);
        const el = g.document.getElementById('out');
        if (el === null) return false;
        el.innerHTML = svg;
        return true;
      }, mermaid);
      if (!ok) throw new Error('mermaid render produced no output');
      const safe = path.basename(
        filename.endsWith('.png') ? filename : `${filename}.png`,
      );
      const el = await page.$('#out');
      if (el === null) throw new Error('diagram container missing');
      const png = await el.screenshot({ type: 'png' });
      await fs.writeFile(safe, Buffer.from(png));
      return safe;
    } finally {
      await browser.close();
    }
  };

  // Run Python in the workspace (charts land there for /get). MPLBACKEND=Agg so
  // matplotlib renders headless.
  const pythonRun = async (code: string): Promise<string> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-py-'));
    try {
      const scriptPath = path.join(dir, 'script.py');
      await fsp.writeFile(scriptPath, code);
      try {
        const { stdout, stderr } = await execFileAsync(
          config.imagegenPython,
          [scriptPath],
          {
            cwd: workspaceDir,
            timeout: 120_000,
            maxBuffer: 4_000_000,
            env: { ...process.env, MPLBACKEND: 'Agg' },
          },
        );
        const combined = stdout + (stderr.trim() === '' ? '' : `\n[stderr] ${stderr}`);
        return combined.trim().slice(0, 4000) || '(no output)';
      } catch (thrown) {
        const e = thrown as { stdout?: string; stderr?: string; message: string };
        return `Python error:\n${(e.stderr ?? e.stdout ?? e.message).slice(0, 2000)}`;
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // Ollama's native API root (drop the /v1 OpenAI suffix) — used for embeddings,
  // vision, and translation, which call Ollama directly rather than via the model.
  const ollamaRoot = config.ollamaBaseUrl.replace(/\/v1\/?$/, '');

  // OCR a workspace image via Tesseract. Confined to the workspace: the path is
  // resolved against it and must stay inside.
  const ocrRun = async (wsPath: string): Promise<string> => {
    const abs = path.resolve(workspaceDir, wsPath);
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
      throw new Error('path escapes the workspace');
    }
    const { stdout } = await execFileAsync(config.tesseractBin, [abs, 'stdout']);
    return stdout.trim();
  };

  // Translate text with the local model — one stateless chat call, output only.
  const translate = async (text: string, targetLang: string): Promise<string> => {
    const res = await fetch(`${ollamaRoot}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              `You are a translation engine. Translate the user's message into ` +
              `${targetLang}. Output ONLY the translation — no notes, no quotes, ` +
              `no preamble, no explanation.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`translate failed: ${String(res.status)}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? '').trim();
  };

  // Fetch JSON/text from a public URL for the intel tools (CVE / arXiv). These
  // are the agent's tools, so keep them behind the SSRF-guarded http client.
  const httpGet = async (target: string): Promise<Response> => {
    const res = await fetch(target, { headers: { 'user-agent': 'hermes-telegram' } });
    if (!res.ok) throw new Error(`GET ${target} -> ${String(res.status)}`);
    return res;
  };
  const cveSearch = async (keyword: string): Promise<string> => {
    const body: unknown = await (await httpGet(nvdUrl(keyword))).json();
    return formatCves(keyword, parseNvd(body));
  };
  const arxivSearch = async (query: string): Promise<string> => {
    const xml = await (await httpGet(arxivUrl(query))).text();
    return formatPapers(query, parseArxiv(xml));
  };

  const tools = buildTools({
    fs,
    http,
    githubToken: config.githubToken,
    ...(config.enableSecurity ? { cveSearch } : {}),
    ...(config.enableResearch ? { arxivSearch } : {}),
    ...(shell === undefined ? {} : { shell }),
    ...(config.enableBrowser ? { browse, renderPdf } : {}),
    ...(config.enablePython && config.imagegenPython !== '' ? { pythonRun } : {}),
    ...(config.enableOcr ? { ocrRun } : {}),
    ...(config.enableTranslate ? { translate } : {}),
    ...(config.enableDiagram && config.mermaidAsset !== '' ? { renderDiagram } : {}),
  });
  const executor = toolExecutor(tools, { logger });

  // Persistent memory: embed text with Ollama's native /api/embed and store it
  // under the data dir (outside the model-writable workspace).
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
    memory: memory.asMemoryAdapter([
      DOCS_SUBJECT,
      REPO_SUBJECT,
    ]) as unknown as MemoryAdapter,
    recall: config.memoryRecall,
    ownerProfile: config.ownerProfile,
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

  // Recurring agent tasks (/every). Stored in LOCAL-time cron; converted to UTC
  // when armed, because the scheduler evaluates cron against UTC.
  const tasksFile = path.resolve(config.dataDir, 'tasks.json');
  let tasks = await loadJsonArray<ScheduledTask>(tasksFile);
  const tzOffset = new Date().getTimezoneOffset();
  const saveTasks = (): Promise<void> =>
    fsp.writeFile(tasksFile, JSON.stringify(tasks), 'utf8');
  const armTask = (task: ScheduledTask): void => {
    scheduler.add(
      {
        id: task.id,
        trigger: { kind: 'cron', expression: localCronToUtc(task.cron, tzOffset) },
        payload: {
          kind: 'task',
          id: task.id,
          chatId: task.chatId,
          prompt: task.prompt,
        },
      },
      Date.now(),
    );
  };
  const onSchedule = async (
    chatId: number,
    cron: string,
    prompt: string,
  ): Promise<string> => {
    const id = `job_${String(Date.now())}_${String(tasks.length)}`;
    const task: ScheduledTask = { id, chatId, cron, prompt };
    tasks.push(task);
    await saveTasks();
    armTask(task);
    return `🗓 Scheduled ${id}: [${cron}] "${prompt}". Manage with /schedules and /unschedule.`;
  };
  const onSchedules = (chatId: number): Promise<string> => {
    const mine = tasks.filter((t) => t.chatId === chatId);
    if (mine.length === 0)
      return Promise.resolve('No recurring tasks. Add one with /every.');
    return Promise.resolve(
      mine.map((t) => `• ${t.id} — [${t.cron}] ${t.prompt}`).join('\n'),
    );
  };
  const onUnschedule = async (chatId: number, id: string): Promise<string> => {
    const found = tasks.find((t) => t.id === id && t.chatId === chatId);
    if (found === undefined) return `No task ${id} for this chat.`;
    tasks = tasks.filter((t) => t.id !== id);
    await saveTasks();
    scheduler.remove(id);
    return `🗑 Cancelled ${id}.`;
  };

  // Application tracker: persist applications and schedule a follow-up reminder
  // (reusing the reminder machinery) a configurable number of days out.
  const applicationsFile = path.resolve(config.dataDir, 'applications.json');
  const applications = await loadJsonArray<Application>(applicationsFile);
  const saveApplications = (): Promise<void> =>
    fsp.writeFile(applicationsFile, JSON.stringify(applications), 'utf8');
  const onApply = async (
    chatId: number,
    company: string,
    role: string,
  ): Promise<string> => {
    const id = `app_${String(Date.now())}_${String(applications.length)}`;
    applications.push({
      id,
      chatId,
      company,
      role,
      status: 'applied',
      atMs: Date.now(),
    });
    await saveApplications();
    const days = config.applicationFollowupDays;
    const remId = `${id}_followup`;
    const label = role === '' ? company : `${company} (${role})`;
    const reminder = {
      id: remId,
      chatId,
      atMs: Date.now() + days * 86_400_000,
      message: `Follow up on your application to ${label}?`,
    };
    reminders.push(reminder);
    await saveReminders();
    scheduler.add(
      {
        id: remId,
        trigger: { kind: 'once', atMs: reminder.atMs },
        payload: { kind: 'reminder', ...reminder },
      },
      Date.now(),
    );
    return `📋 Logged ${id}: ${label}. I'll nudge you to follow up in ${String(days)} days.`;
  };
  const onApplications = (chatId: number): Promise<string> =>
    Promise.resolve(
      formatApplications(applications.filter((a) => a.chatId === chatId)),
    );
  const onAppStatus = async (
    chatId: number,
    id: string,
    status: string,
  ): Promise<string> => {
    const app = applications.find((a) => a.id === id && a.chatId === chatId);
    if (app === undefined) return `No application ${id} for this chat.`;
    app.status = status.toLowerCase() as AppStatus;
    await saveApplications();
    return `Updated ${id} → ${app.status}.`;
  };

  // /cve and /arxiv reuse the intel search ports the agent tools use.
  const onCve = cveSearch;
  const onArxiv = arxivSearch;

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

  // Career toolkit + code review: run the agent on a prepared prompt (the owner
  // profile is always in the system prompt; the résumé is recalled if ingested).
  const runAgentPrompt = async (prompt: string, chatId: number): Promise<string> => {
    const result = await runtime.run(AGENT_NAME, {
      input: prompt,
      subject: String(chatId),
    });
    return replyText(result);
  };
  const onCareer = runAgentPrompt;
  const onReview = runAgentPrompt;

  // /scan: GET a URL and grade its security response headers (read-only, safe).
  const onScan = async (url: string): Promise<string> => {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const res = await fetch(target, {
      method: 'GET',
      headers: { 'user-agent': 'hermes-telegram-scan' },
      redirect: 'follow',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return formatSecurityReport(target, analyzeSecurityHeaders(headers));
  };

  // /repo: walk a local source repo, keep the source files, and embed them under
  // REPO_SUBJECT so questions are answered across the whole codebase.
  const onRepo = async (repoPath: string): Promise<string> => {
    const root = path.resolve(repoPath);
    const stat = await fsp.stat(root).catch(() => null);
    if (stat?.isDirectory() !== true) {
      return `Not a directory: ${repoPath}`;
    }
    const repoName = path.basename(root);
    const files = await walkFiles(root);
    const docs: { name: string; content: string }[] = [];
    for (const full of files) {
      const rel = path.relative(root, full);
      if (!shouldIngestPath(rel)) continue;
      const info = await fsp.stat(full).catch(() => null);
      if (info === null || info.size > 200_000) continue; // skip huge files
      try {
        const content = await fsp.readFile(full, 'utf8');
        if (content.includes('\u0000')) continue; // binary sniff
        docs.push({ name: `${repoName}/${rel}`, content });
      } catch {
        // Unreadable/binary file — skip it.
      }
    }
    if (docs.length === 0) return `No source files found under ${repoPath}.`;
    const chunks = await ingestDocs(memory, docs, REPO_SUBJECT);
    return `Indexed ${String(docs.length)} file(s) from ${repoName} into ${String(chunks)} chunks. Ask me anything about the code!`;
  };

  // A photo: download it via the raw Telegram Bot API and describe it with the
  // Ollama vision model (bypassing @hermes/model, which is text-only).
  const token = config.telegramBotToken;

  // Download a Telegram file by id to a Buffer (getFile → file endpoint).
  const downloadTgFile = async (fileId: string): Promise<Buffer> => {
    const meta = (await (
      await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    ).json()) as { result?: { file_path?: string } };
    const filePath = meta.result?.file_path;
    if (filePath === undefined) throw new Error('Telegram getFile returned no path');
    const bytes = await (
      await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
    ).arrayBuffer();
    return Buffer.from(bytes);
  };

  // A photo captioned "read this": download it and OCR it with Tesseract.
  const onOcr = async (fileId: string): Promise<string> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-ocr-'));
    try {
      const img = path.join(dir, 'in.png');
      await fsp.writeFile(img, await downloadTgFile(fileId));
      const { stdout } = await execFileAsync(config.tesseractBin, [img, 'stdout']);
      return stdout.trim();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // A photo captioned "receipt"/"extract": OCR it, then have the model turn the
  // text into clean JSON.
  const onExtract = async (fileId: string): Promise<string> => {
    const text = await onOcr(fileId);
    if (text === '') return '(no text found to extract)';
    const res = await fetch(`${ollamaRoot}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content:
              'You extract structured data from OCR text (receipts, invoices, ' +
              'business cards). Return ONLY a compact JSON object with the ' +
              'relevant fields (e.g. merchant, date, total, currency, items, or ' +
              'name, title, company, email, phone). No prose, no code fence.',
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`extract failed: ${String(res.status)}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? '').trim() || '(the model returned nothing)';
  };

  // A photo captioned "remove background": run rembg, send back a PNG cutout as a
  // document (sendPhoto would flatten the transparency).
  const onRemoveBg = async (fileId: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-bg-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'cutout.png');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(config.imagegenPython, [config.rembgScript, inPath, out], {
        timeout: 300_000,
      });
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('document', new Blob([await fsp.readFile(out)]), 'cutout.png');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendDocument failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // A photo captioned "blur faces": detect and blur faces (OpenCV), send it back.
  const onBlurFaces = async (fileId: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-face-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'blurred.png');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(config.imagegenPython, [config.blurFacesScript, inPath, out]);
      await sendPhoto(chatId, await fsp.readFile(out), 'blurred.png');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // A photo captioned "meme: top | bottom": caption it (Pillow) and send it back.
  const onMeme = async (
    fileId: string,
    top: string,
    bottom: string,
    chatId: number,
  ): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-meme-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'meme.png');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(config.imagegenPython, [
        config.memeScript,
        inPath,
        out,
        top,
        bottom,
      ]);
      await sendPhoto(chatId, await fsp.readFile(out), 'meme.png');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // A photo captioned "sticker": cut it out and send a 512px WebP sticker.
  const onSticker = async (fileId: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-stk-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'sticker.webp');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(config.imagegenPython, [config.stickerScript, inPath, out], {
        timeout: 300_000,
      });
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('sticker', new Blob([await fsp.readFile(out)]), 'sticker.webp');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendSticker`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendSticker failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // Upload an audio file to a chat (title shows in the player).
  const sendAudioFile = async (
    chatId: number,
    file: string,
    name: string,
    title: string,
  ): Promise<void> => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('title', title);
    form.append('audio', new Blob([await fsp.readFile(file)]), name);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`sendAudio failed: ${String(res.status)}`);
  };

  // A photo captioned "upscale"/"enhance": 4x AI super-resolution, sent as a
  // document to preserve the full resolution.
  const onUpscale = async (fileId: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-up-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'upscaled.png');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(config.imagegenPython, [config.upscaleScript, inPath, out], {
        timeout: 600_000,
      });
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('document', new Blob([await fsp.readFile(out)]), 'upscaled.png');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendDocument failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // A photo captioned "erase the <object>": text-guided inpainting, sent back.
  const onInpaint = async (
    fileId: string,
    target: string,
    chatId: number,
  ): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-inp-'));
    try {
      const inPath = path.join(dir, 'in.png');
      const out = path.join(dir, 'edited.png');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(
        config.imagegenPython,
        [config.inpaintScript, inPath, out, target],
        { timeout: 600_000 },
      );
      await sendPhoto(chatId, await fsp.readFile(out), 'edited.png');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // An audio file captioned "instrumental"/"vocals only": split with Demucs and
  // send the requested stem(s) as audio tracks.
  const onStemSplit = async (
    fileId: string,
    choice: 'vocals' | 'instrumental' | 'both',
    chatId: number,
  ): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-stem-'));
    try {
      const inPath = path.join(dir, 'in.audio');
      const vocals = path.join(dir, 'vocals.mp3');
      const instrumental = path.join(dir, 'instrumental.mp3');
      await fsp.writeFile(inPath, await downloadTgFile(fileId));
      await execFileAsync(
        config.imagegenPython,
        [config.stemScript, inPath, vocals, instrumental],
        { timeout: 600_000 },
      );
      if (choice === 'vocals' || choice === 'both') {
        await sendAudioFile(chatId, vocals, 'vocals.mp3', 'Vocals');
      }
      if (choice === 'instrumental' || choice === 'both') {
        await sendAudioFile(chatId, instrumental, 'instrumental.mp3', 'Instrumental');
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // A photo captioned "scan qr": download it and decode any QR codes (OpenCV).
  const onQr = async (fileId: string): Promise<string> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-qr-'));
    try {
      const img = path.join(dir, 'in.png');
      await fsp.writeFile(img, await downloadTgFile(fileId));
      const { stdout } = await execFileAsync(config.imagegenPython, [
        config.qrReadScript,
        img,
      ]);
      return stdout.trim();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // /qr <text>: generate a QR code PNG and send it back as a photo.
  const onQrMake = async (text: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-qr-'));
    try {
      const out = path.join(dir, 'qr.png');
      await execFileAsync(config.imagegenPython, [config.qrMakeScript, text, out]);
      await sendPhoto(chatId, await fsp.readFile(out), 'qr.png');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

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

  // /audiobook <path>: narrate a workspace doc (.md/.txt/.pdf) to an MP3 and send
  // it as an audio track. Reuses the same TTS engine as voice replies.
  const onAudiobook = async (wsPath: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-book-'));
    try {
      const bytes = Buffer.from(await fs.readFile(wsPath));
      let text: string;
      if (wsPath.toLowerCase().endsWith('.pdf')) {
        const pdf = path.join(dir, 'in.pdf');
        await fsp.writeFile(pdf, bytes);
        const { stdout } = await execFileAsync('pdftotext', [pdf, '-']);
        text = stdout;
      } else {
        text = bytes.toString('utf8');
      }
      text = text.replace(/\s+/g, ' ').trim().slice(0, config.audiobookMaxChars);
      if (text === '') throw new Error('nothing to narrate');
      const raw = path.join(dir, config.ttsMode === 'piper' ? 'out.wav' : 'out.aiff');
      const mp3 = path.join(dir, 'audiobook.mp3');
      if (config.ttsMode === 'piper') {
        const txt = path.join(dir, 'in.txt');
        await fsp.writeFile(txt, text);
        await execFileAsync(
          'sh',
          [
            '-c',
            'exec "$1" -m "$2" -f "$3" < "$4"',
            'sh',
            config.piperBin,
            config.piperModel,
            raw,
            txt,
          ],
          { timeout: 600_000 },
        );
      } else {
        await execFileAsync(config.ttsCommand, ['-o', raw, text], { timeout: 600_000 });
      }
      await execFileAsync('ffmpeg', ['-y', '-i', raw, '-b:a', '96k', mp3]);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('title', path.basename(wsPath));
      form.append('audio', new Blob([await fsp.readFile(mp3)]), 'audiobook.mp3');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendAudio failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // /video <prompt>: generate a short animated clip locally and send it.
  const onVideo = async (prompt: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-vid-'));
    try {
      const out = path.join(dir, 'clip.mp4');
      await execFileAsync(config.imagegenPython, [config.videoScript, prompt, out], {
        timeout: 600_000,
      });
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('video', new Blob([await fsp.readFile(out)]), 'clip.mp4');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendVideo failed: ${String(res.status)}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  };

  // /musicvideo: generate a clip and a soundtrack, then mux them — the video is
  // looped to fill the music's length (-shortest stops at the audio's end).
  const onMusicVideo = async (prompt: string, chatId: number): Promise<void> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-mv-'));
    try {
      const clip = path.join(dir, 'clip.mp4');
      const music = path.join(dir, 'music.wav');
      const out = path.join(dir, 'musicvideo.mp4');
      await execFileAsync(config.imagegenPython, [config.videoScript, prompt, clip], {
        timeout: 600_000,
      });
      await execFileAsync(config.imagegenPython, [config.musicScript, prompt, music], {
        timeout: 600_000,
      });
      await execFileAsync('ffmpeg', [
        '-y',
        '-stream_loop',
        '-1',
        '-i',
        clip,
        '-i',
        music,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        out,
      ]);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('video', new Blob([await fsp.readFile(out)]), 'musicvideo.mp4');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`sendVideo failed: ${String(res.status)}`);
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
    ...(config.enableOcr ? { onOcr } : {}),
    ...(config.enableImagegen &&
    config.imagegenPython !== '' &&
    config.rembgScript !== ''
      ? { onRemoveBg }
      : {}),
    ...(config.whisperModel === '' ? {} : { onVoice, onTranscribeFile: onVoice }),
    ...(config.enableTranslate
      ? { onTranslate: (to, text) => translate(text, to) }
      : {}),
    ...(config.imagegenPython !== '' && config.qrReadScript !== '' ? { onQr } : {}),
    ...(config.imagegenPython !== '' && config.qrMakeScript !== '' ? { onQrMake } : {}),
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
    ...(config.enableRepoQa ? { onRepo } : {}),
    ...(config.enableCareer ? { onCareer } : {}),
    ...(config.enableReview ? { onReview } : {}),
    ...(config.enableSecurity ? { onScan, onCve } : {}),
    ...(config.enableResearch ? { onArxiv } : {}),
    ...(config.enableApplications ? { onApply, onApplications, onAppStatus } : {}),
    ...(config.enableAudiobook ? { onAudiobook } : {}),
    ...(config.imagegenPython !== '' && config.videoScript !== '' ? { onVideo } : {}),
    ...(config.enableMusicVideo &&
    config.imagegenPython !== '' &&
    config.videoScript !== '' &&
    config.musicScript !== ''
      ? { onMusicVideo }
      : {}),
    ...(config.enableOcr && config.enableExtract ? { onExtract } : {}),
    ...(config.enableSchedules ? { onSchedule, onSchedules, onUnschedule } : {}),
    ...(config.imagegenPython !== '' && config.blurFacesScript !== ''
      ? { onBlurFaces }
      : {}),
    ...(config.imagegenPython !== '' && config.memeScript !== '' ? { onMeme } : {}),
    ...(config.imagegenPython !== '' && config.stickerScript !== ''
      ? { onSticker }
      : {}),
    ...(config.imagegenPython !== '' && config.upscaleScript !== ''
      ? { onUpscale }
      : {}),
    ...(config.imagegenPython !== '' && config.inpaintScript !== ''
      ? { onInpaint }
      : {}),
    ...(config.imagegenPython !== '' && config.stemScript !== ''
      ? { onStemSplit }
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
  // Re-arm recurring agent tasks persisted from before a restart.
  for (const task of tasks) armTask(task);
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
  // A recurring agent task: run the agent on its prompt and message the result.
  const runTask = async (payload: {
    chatId: number;
    prompt: string;
  }): Promise<void> => {
    const result = await runtime.run(AGENT_NAME, {
      input: payload.prompt,
      subject: String(payload.chatId),
    });
    await client.sendMessage({
      chatId: payload.chatId,
      text: `🗓 ${replyText(result)}`,
    });
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
      case 'task':
        return runTask(payload);
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
