/**
 * The bot's configuration schema — declared once, read from the environment via
 * `@hermes/config`. Every knob the bot takes is here; `main.ts` loads it.
 *
 * Env var names derive from the field names in SCREAMING_SNAKE_CASE, so
 * `telegramBotToken` reads `TELEGRAM_BOT_TOKEN`, `ollamaModel` reads
 * `OLLAMA_MODEL`, and so on.
 */

import {
  boolean,
  integer,
  list,
  number,
  oneOf,
  string,
  url,
  type Config,
} from '@hermes/config';

export const telegramSchema = {
  /**
   * The BotFather token. `TELEGRAM_BOT_TOKEN`. Required — the bot refuses to
   * start without it, because there is nothing it can do with no account.
   */
  telegramBotToken: string()
    .secret()
    .describe('Telegram Bot API token from @BotFather.'),

  /**
   * The Ollama OpenAI-compatible endpoint. `OLLAMA_BASE_URL`. Note the `/v1`
   * suffix: that is the OpenAI-compatible surface, not Ollama's native API.
   */
  ollamaBaseUrl: url()
    .default('http://localhost:11434/v1')
    .describe("Ollama's OpenAI-compatible base URL."),

  /** The model tag to run, e.g. `qwen2.5:7b`. `OLLAMA_MODEL`. */
  ollamaModel: string()
    .default('qwen2.5:0.5b')
    .describe('The Ollama model tag the agent reasons with.'),

  /**
   * HTTP timeout for a model call, in ms. `MODEL_TIMEOUT_MS`. Generous by
   * default: a local model cold-loads several GB from disk on its first request
   * after a restart, which easily exceeds a web client's usual 30s.
   */
  modelTimeoutMs: integer()
    .default(120_000)
    .describe('HTTP timeout for model calls in ms.'),

  /**
   * The directory the agent's filesystem tools are confined to. `WORKSPACE_DIR`.
   * All reads and writes are rooted here, so the bot cannot touch the rest of
   * the disk even if the model asks it to.
   */
  workspaceDir: string()
    .default('./hermes-workspace')
    .describe('Directory the filesystem tools are confined to.'),

  /**
   * Whether to give the agent shell tools. `ENABLE_SHELL`. Off by default:
   * running commands from a chat message is powerful and worth an explicit opt
   * in. When on, only the allowlisted programs can run.
   */
  enableShell: boolean()
    .default(false)
    .describe('Enable the (allowlisted) shell tool.'),

  /**
   * Programs the shell tool may run when `enableShell` is set.
   * `SHELL_ALLOWLIST`, comma-separated. Matched on program name only; arguments
   * are never interpreted. The default is a developer set (scaffold, install,
   * build, commit) — deliberately without `rm`/`sudo`. Note that `node`/`npm`
   * can themselves run arbitrary code, so this is a soft boundary, not a jail.
   */
  shellAllowlist: list()
    .default([
      'ls',
      'cat',
      'echo',
      'pwd',
      'date',
      'head',
      'tail',
      'wc',
      'grep',
      'find',
      'mkdir',
      'touch',
      'cp',
      'which',
      'sed',
      'node',
      'npm',
      'npx',
      'pnpm',
      'yarn',
      'git',
      'tsc',
    ])
    .describe('Comma-separated programs the shell tool may run.'),

  /**
   * Command-line deny patterns (regex sources) refused by the safety guard.
   * `SHELL_DENY`, comma-separated. Empty uses the built-in defaults (rm -rf,
   * sudo, --force, fork bombs, curl|sh, …), which catch danger even inside
   * `node -e`.
   */
  shellDeny: list().default([]).describe('Regex patterns the shell guard refuses.'),

  /**
   * Timeout for a single shell command, in ms. `SHELL_TIMEOUT_MS`. Generous
   * because an `npm install` or a build easily outlasts a 30s default.
   */
  shellTimeoutMs: integer()
    .default(180_000)
    .describe('Timeout for one shell command in ms.'),

  /**
   * Output cap for a single shell command, in bytes. `SHELL_MAX_OUTPUT_BYTES`.
   * Raised from the 1 MB default so a verbose install log is not truncated.
   */
  shellMaxOutputBytes: integer()
    .default(4_000_000)
    .describe('Max captured output per shell command, in bytes.'),

  /**
   * The most reasoning turns a single message may take. `MAX_TURNS`. Each turn
   * is one model call plus any tools it asked for; the budget stops a runaway
   * loop from answering a phone message forever.
   */
  maxTurns: integer().default(12).describe('Max reasoning turns per message.'),

  /** The Ollama embedding model for memory/RAG. `EMBEDDING_MODEL`. */
  embeddingModel: string()
    .default('all-minilm')
    .describe('Ollama model used to embed memories and documents.'),

  /**
   * Ollama vision model for photo messages. `VISION_MODEL`. Empty disables image
   * input. Must be a multimodal model (e.g. llava:7b, llama3.2-vision).
   */
  visionModel: string()
    .default('llava:7b')
    .describe('Ollama vision model (empty = off).'),

  /**
   * Path to a whisper.cpp ggml model for voice-note transcription.
   * `WHISPER_MODEL`. Empty disables voice. Requires whisper-cli + ffmpeg on PATH.
   */
  whisperModel: string().default('').describe('whisper.cpp model path (empty = off).'),

  /** The whisper.cpp CLI binary. `WHISPER_CLI`. */
  whisperCli: string().default('whisper-cli').describe('whisper.cpp CLI command.'),

  /**
   * Reply with a spoken voice note when the user sent one. `ENABLE_VOICE_REPLIES`.
   * Needs a local TTS command (macOS `say`) and ffmpeg.
   */
  enableVoiceReplies: boolean()
    .default(false)
    .describe('Speak replies to voice notes (needs say + ffmpeg).'),

  /** The text-to-speech command. `TTS_COMMAND`. macOS `say` by default. */
  ttsCommand: string().default('say').describe('TTS command (writes AIFF via -o).'),

  /** TTS engine. `TTS_MODE`. 'say' (macOS) or 'piper' (natural neural voice). */
  ttsMode: oneOf(['say', 'piper']).default('say').describe('TTS engine.'),

  /** Piper binary and voice model, when TTS_MODE=piper. `PIPER_BIN` / `PIPER_MODEL`. */
  piperBin: string().default('piper').describe('Piper binary.'),
  piperModel: string().default('').describe('Piper voice .onnx model path.'),

  /**
   * Give the agent a headless-browser tool and enable /screenshot. `ENABLE_BROWSER`.
   * Requires playwright + a browser (`npx playwright install chromium`).
   */
  enableBrowser: boolean()
    .default(false)
    .describe('Enable the browser tool (Playwright).'),

  /**
   * Enable /imagine local image generation. `ENABLE_IMAGEGEN`. Requires the SD
   * python venv (torch + diffusers) — see IMAGEGEN_PYTHON / IMAGEGEN_SCRIPT.
   */
  enableImagegen: boolean()
    .default(false)
    .describe('Enable /imagine (Stable Diffusion).'),

  /** Python interpreter (venv) for image generation. `IMAGEGEN_PYTHON`. */
  imagegenPython: string().default('').describe('Python (venv) with torch+diffusers.'),

  /** The image-generation script. `IMAGEGEN_SCRIPT`. Called: python script <prompt> <out.png>. */
  imagegenScript: string().default('').describe('Path to the SD generate script.'),

  /** The img2img script. `IMG2IMG_SCRIPT`. Called: python script <prompt> <in.png> <out.png>. */
  img2imgScript: string().default('').describe('Path to the SD img2img script.'),

  /** GitHub token for the GitHub tools. `GITHUB_TOKEN`. Empty disables them. */
  githubToken: string().secret().default('').describe('GitHub token (empty = off).'),

  /** MusicGen script for /music (uses IMAGEGEN_PYTHON). `MUSIC_SCRIPT`. Empty = off. */
  musicScript: string().default('').describe('MusicGen script path (empty = off).'),

  /**
   * Give the agent a python.run tool (data analysis + charts). `ENABLE_PYTHON`.
   * Runs arbitrary Python via IMAGEGEN_PYTHON — like the shell, an explicit opt-in.
   */
  enablePython: boolean().default(false).describe('Enable the python.run tool.'),

  /**
   * OCR: read text out of photos (caption "read this") and an image.ocr tool.
   * `ENABLE_OCR`. Requires the Tesseract binary on PATH (`brew install tesseract`).
   */
  enableOcr: boolean().default(false).describe('Enable OCR (needs tesseract).'),

  /** The Tesseract OCR binary. `TESSERACT_BIN`. */
  tesseractBin: string().default('tesseract').describe('Tesseract OCR binary.'),

  /**
   * Background removal for photos (caption "remove background"). `REMBG_SCRIPT`.
   * Path to the rembg script; runs via IMAGEGEN_PYTHON. Empty disables it.
   */
  rembgScript: string().default('').describe('rembg cutout script path (empty = off).'),

  /**
   * Give the agent a text.translate tool and a /translate command. `ENABLE_TRANSLATE`.
   * Uses the local Ollama model — no extra dependency — so on by default.
   */
  enableTranslate: boolean().default(true).describe('Enable translation.'),

  /**
   * Give the agent a diagram.render tool (Mermaid → PNG). `ENABLE_DIAGRAM`.
   * Renders via headless Chromium (needs ENABLE_BROWSER's Playwright) and a
   * vendored mermaid.js at MERMAID_ASSET.
   */
  enableDiagram: boolean().default(false).describe('Enable Mermaid diagrams.'),

  /** Path to the vendored mermaid.min.js used to render diagrams. `MERMAID_ASSET`. */
  mermaidAsset: string().default('').describe('Path to mermaid.min.js.'),

  /**
   * QR codes: a /qr command (generate) and photo scanning ("scan qr"). The
   * generate/read scripts run via IMAGEGEN_PYTHON. `QR_MAKE_SCRIPT` / `QR_READ_SCRIPT`.
   * Empty disables that direction.
   */
  qrMakeScript: string().default('').describe('QR generate script (empty = off).'),
  qrReadScript: string().default('').describe('QR read script (empty = off).'),

  /** Serve a read-only dashboard on 127.0.0.1:PORT. `DASHBOARD_PORT`. 0 = off. */
  dashboardPort: integer().default(0).describe('Local dashboard port (0 = off).'),

  /**
   * Where persistent data (the memory store) lives. `DATA_DIR`. Kept out of the
   * agent's writable workspace so the model cannot tamper with its own memory.
   */
  dataDir: string()
    .default('./hermes-data')
    .describe('Directory for the bot’s persistent data.'),

  /**
   * Folder whose files are ingested for "chat with my files" on `/ingest`.
   * `DOCS_DIR`. Drop .md/.txt/.json/code files here, then send /ingest.
   */
  docsDir: string()
    .default('./hermes-docs')
    .describe('Folder of documents ingested for RAG.'),

  /**
   * How many memories to recall into the prompt each turn. `MEMORY_RECALL`.
   * 0 disables memory. Each recall costs one embedding call.
   */
  memoryRecall: integer()
    .default(5)
    .describe('Memories recalled per message (0 = off).'),

  /**
   * Route each request through a team of specialist agents (researcher, coder,
   * planner) behind a coordinator. `ENABLE_TEAM`. Off falls back to one agent.
   */
  enableTeam: boolean().default(true).describe('Use a team of specialist agents.'),

  /** Send a scheduled morning briefing. `ENABLE_BRIEFING`. */
  enableBriefing: boolean().default(true).describe('Send a daily morning briefing.'),

  /** Cron for the briefing (5-field, UTC). `BRIEFING_CRON`. Default 08:00 IST. */
  briefingCron: string().default('30 2 * * *').describe('Briefing cron (UTC).'),

  /** City name shown in the briefing. `BRIEFING_CITY`. */
  briefingCity: string()
    .default('Bengaluru')
    .describe('City for the briefing weather.'),

  /** Latitude/longitude for the weather lookup. `BRIEFING_LAT` / `BRIEFING_LON`. */
  briefingLat: number().default(12.97).describe('Weather latitude.'),
  briefingLon: number().default(77.59).describe('Weather longitude.'),

  /**
   * Chat to send scheduled messages to. `BRIEFING_CHAT_ID`. If unset, every chat
   * that has messaged the bot (from memory) receives them.
   */
  briefingChatId: integer()
    .optional()
    .describe('Target chat id for scheduled messages.'),

  /**
   * Repo to watch CI for, `owner/name`. `CI_REPO`. Empty disables the watcher.
   * Uses the public GitHub Actions API — no token needed for a public repo.
   */
  ciRepo: string().default('').describe('owner/name to watch CI for (empty = off).'),

  /** Branch whose CI is watched. `CI_BRANCH`. */
  ciBranch: string().default('main').describe('Branch to watch CI for.'),

  /** Cron for the CI check (5-field, UTC). `CI_CRON`. Default ~23:30 IST. */
  ciCron: string().default('0 18 * * *').describe('CI-watcher cron (UTC).'),

  /** Send a daily git standup of recent commits. `ENABLE_STANDUP`. */
  enableStandup: boolean().default(false).describe('Send a daily git standup.'),

  /** Local repo paths to summarise in the standup. `STANDUP_REPOS`, comma-separated. */
  standupRepos: list().default([]).describe('Local repo paths for the standup.'),

  /** Cron for the standup (5-field, UTC). `STANDUP_CRON`. Default ~08:30 IST. */
  standupCron: string().default('0 3 * * *').describe('Standup cron (UTC).'),

  /** How often to poll Telegram for updates, in ms. `POLL_INTERVAL_MS`. */
  pollIntervalMs: integer().default(1_000).describe('Long-poll interval in ms.'),

  /** Minimum log level. `LOG_LEVEL`. */
  logLevel: oneOf(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Chat ids allowed to use the bot. `ALLOWED_CHAT_IDS`, comma-separated. Empty
   * means everyone — set this to your own chat id, because the shell tool runs
   * code. Message the bot once to see your id in the "private" reply.
   */
  allowedChatIds: list().default([]).describe('Chat ids allowed to use the bot.'),

  /** A name stamped on every log line. `SERVICE_NAME`. */
  serviceName: string().default('hermes-telegram'),
};

export type TelegramConfig = Config<typeof telegramSchema>;
