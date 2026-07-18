# @hermes/telegram-app

A Telegram bot that turns each message into a **HermesOS task-executing agent**
run, backed by a **local Ollama** model. Message it from your phone; it reasons,
calls tools (files, HTTP, optionally shell), and replies.

It is the host that wires four HermesOS subsystems together:

- `@hermes/telegram` — the Bot API client and long-poll dispatcher (the phone
  side).
- `@hermes/provider-openai` — the model, pointed at Ollama's `/v1` endpoint.
- `@hermes/agent` — the reasoning loop (`LlmReasoner` → tool requests → answer).
- `@hermes/tools-*` — the tools the agent runs, over confined ports.

## How it fits together

```
Telegram message
  → TelegramBot (long-poll)                 bot.ts / main.ts
  → AgentRuntime.run(assistant, {input})    agent.ts
      → LlmReasoner asks Ollama             provider-openai → Ollama
      → model requests a tool               (ToolsDecision)
      → toolExecutor runs it                executor.ts  ← the host's side of the port
      → observation fed back, loop          up to MAX_TURNS
  → replyText(result) → ctx.reply(...)      agent.ts / bot.ts
```

`@hermes/agent` ships only a kernel-backed executor; a chat bot has no kernel
`Runtime`, so `executor.ts` is the small `AgentExecutor` that runs the tools
directly (validating the model's arguments against each tool's schema via
`callTool`, exactly as the kernel would).

## Run it

1. **Get a bot token.** In Telegram, message
   [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **Have a model.** Ollama must be running with a chat model pulled. A capable
   model matters — a 0.5b model connects but cannot use tools reliably:
   ```bash
   ollama pull qwen2.5:7b
   ```
3. **Configure.** In the repo root `.env` (see `.env.example`):
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC...
   OLLAMA_MODEL=qwen2.5:7b
   # optional: ENABLE_SHELL=true
   ```
4. **Start the bot** (long-poll — no public URL or webhook needed):
   ```bash
   pnpm --filter @hermes/telegram-app dev      # watch mode
   # or: pnpm --filter @hermes/telegram-app build && pnpm --filter @hermes/telegram-app start
   ```
5. Open your bot in Telegram, send `/start`, then a task: `summarise notes.md`,
   or `fetch https://example.com and tell me the title`.

## Configuration

Every field reads a SCREAMING_SNAKE env var of its name (see `src/config.ts`):

| Env var              | Default                     | Purpose                                    |
| -------------------- | --------------------------- | ------------------------------------------ |
| `TELEGRAM_BOT_TOKEN` | — (required)                | BotFather token.                           |
| `OLLAMA_BASE_URL`    | `http://localhost:11434/v1` | Ollama's OpenAI-compatible endpoint.       |
| `OLLAMA_MODEL`       | `qwen2.5:0.5b`              | Chat model tag. Use 7b+ for real tool use. |
| `WORKSPACE_DIR`      | `./hermes-workspace`        | Directory the file tools are confined to.  |
| `ENABLE_SHELL`       | `false`                     | Enable the allowlisted shell tool.         |
| `SHELL_ALLOWLIST`    | `ls,cat,echo,…`             | Programs the shell tool may run.           |
| `MAX_TURNS`          | `6`                         | Max reasoning turns per message.           |
| `POLL_INTERVAL_MS`   | `1000`                      | Long-poll interval.                        |

## Safety posture

- **Files** are confined to `WORKSPACE_DIR` via `rooted()` — the agent cannot
  touch the rest of the disk even if the model asks it to.
- **HTTP** goes through `guarded({ policy: { blockPrivate: true } })` — loopback
  and private ranges are blocked (SSRF protection).
- **Shell** is off unless `ENABLE_SHELL=true`, and then default-deny: only the
  allowlisted program names run, arguments are passed literally (no shell).

The model itself talks to Ollama through a **bare** client, because Ollama is on
loopback — which the tool guard (correctly) blocks for the agent's own requests.
