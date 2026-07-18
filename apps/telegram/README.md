# @hermes/telegram-app

A **private, offline, phone-controlled AI assistant** — a Telegram bot backed by
local Ollama models on your own machine. It builds things, remembers you, reads
your files, sees images, hears voice notes, and briefs you each morning. No
cloud, no API keys, no per-token cost.

## Features

| Feature                  | What it does                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Task-executing agent** | Writes/reads files, makes HTTP requests, runs allowlisted shell commands (node/npm/git). Scaffolds and builds real projects. |
| **Team of agents**       | A coordinator routes to a **researcher**, **coder**, or **planner** specialist by intent (`ENABLE_TEAM`).                    |
| **Memory**               | Remembers your name, preferences, and past messages per chat — a local embedding store, no database.                         |
| **Chat with your files** | Drop docs in a folder, send `/ingest`, then ask questions grounded in them (RAG).                                            |
| **Image input**          | Send a photo → a local vision model (llava) describes/analyses it.                                                           |
| **Voice notes**          | Send a voice note → whisper.cpp transcribes it → runs as a task.                                                             |
| **Morning briefing**     | Weather + top Hacker News, pushed daily on a cron.                                                                           |
| **CI watcher**           | DMs you when a watched GitHub repo's CI fails.                                                                               |

Everything runs on your machine. Files are confined to a workspace, HTTP is
SSRF-guarded, and the shell is off unless you opt in.

## Quick start

1. **Bot token:** message [@BotFather](https://t.me/BotFather) → `/newbot`.
2. **Models:** a capable chat model matters (a 0.5b model can't use tools).
   ```bash
   ollama pull qwen2.5-coder:32b   # or qwen2.5:7b on less RAM
   ollama pull all-minilm          # embeddings (memory/RAG)
   ollama pull llava:7b            # vision (image input)
   ```
3. **For voice** (optional): `brew install whisper-cpp ffmpeg` and download a
   whisper model, e.g.
   `curl -L -o ~/.cache/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
4. **Run** (see `.env.example` for every knob):
   ```bash
   TELEGRAM_BOT_TOKEN=<token> \
   OLLAMA_MODEL=qwen2.5-coder:32b \
   ENABLE_SHELL=true \
   VISION_MODEL=llava:7b \
   WHISPER_MODEL=~/.cache/whisper/ggml-base.en.bin \
   CI_REPO=<owner/repo> \
   pnpm --filter @hermes/telegram-app start
   ```
5. In Telegram, send `/start`, then talk to it — type, speak, send a photo, or
   drop files + `/ingest`.

## Commands & interactions

- **Any text** → a task the agent works on.
- **`/ingest`** → embed the files in `DOCS_DIR` for "chat with my files".
- **A photo** → described by the vision model (its caption becomes the prompt).
- **A voice note** → transcribed, then run as a task.

## Architecture

```
Telegram (text / photo / voice)
  → bot.ts        route: text→agent, photo→vision, voice→whisper→agent
  → team.ts       coordinator routes to researcher / coder / planner
  → agent.ts      LlmReasoner over Ollama, + memory recall
      → executor.ts   runs the tools the model asks for
      → tools.ts      files (workspace-rooted) + HTTP (SSRF-guarded) + shell
  → memory-store.ts   embed + persist + recall (memory & RAG)
  → briefing.ts + Scheduler   morning briefing + CI watcher
```

The pure, testable pieces live in their own modules (61+ unit tests); `main.ts`
is the impure entrypoint that wires real ports and runs the long-poll loop.

## Safety

- Files confined to `WORKSPACE_DIR` (path-normalised, escape-refused).
- HTTP guarded against SSRF (loopback/private blocked).
- Shell off unless `ENABLE_SHELL=true`, then default-deny allowlist (no
  rm/sudo).
- The memory store lives outside the model-writable workspace.
- **Note:** with the shell on, `node`/`npm` can run arbitrary code — an explicit
  opt-in for a personal machine.
