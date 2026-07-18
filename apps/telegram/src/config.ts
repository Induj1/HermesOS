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
   * are never interpreted. Default is a conservative read-mostly set.
   */
  shellAllowlist: list()
    .default(['ls', 'cat', 'echo', 'pwd', 'date', 'head', 'tail', 'wc', 'grep', 'find'])
    .describe('Comma-separated programs the shell tool may run.'),

  /**
   * The most reasoning turns a single message may take. `MAX_TURNS`. Each turn
   * is one model call plus any tools it asked for; the budget stops a runaway
   * loop from answering a phone message forever.
   */
  maxTurns: integer().default(6).describe('Max reasoning turns per message.'),

  /** How often to poll Telegram for updates, in ms. `POLL_INTERVAL_MS`. */
  pollIntervalMs: integer().default(1_000).describe('Long-poll interval in ms.'),

  /** Minimum log level. `LOG_LEVEL`. */
  logLevel: oneOf(['debug', 'info', 'warn', 'error']).default('info'),

  /** A name stamped on every log line. `SERVICE_NAME`. */
  serviceName: string().default('hermes-telegram'),
};

export type TelegramConfig = Config<typeof telegramSchema>;
