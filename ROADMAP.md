# HermesOS Roadmap

HermesOS is built one subsystem at a time. Each is finished — implementation,
tests, RFC, README — before the next begins, and each is a stable public API
once committed. The ordering follows the dependency graph: nothing is built
before the thing it depends on.

Legend: ✅ complete · 🔜 next · ⬜ planned · 🔑 needs a credential to verify
live

## Foundations

| #   | Subsystem        | Package             | RFC      | Status |
| --- | ---------------- | ------------------- | -------- | ------ |
| 1   | Kernel           | `@hermes/kernel`    | RFC-0001 | ✅     |
| 2   | Memory           | `@hermes/memory`    | RFC-0002 | ✅     |
| 3   | Planner          | `@hermes/planner`   | RFC-0003 | ✅     |
| 4   | Execution Engine | `@hermes/execution` | RFC-0004 | ✅     |
| 5   | Agent Framework  | `@hermes/agent`     | RFC-0005 | ✅     |
| 6   | Model Contracts  | `@hermes/model`     | RFC-0005 | ✅     |
| 7   | Tool Framework   | `@hermes/tools`     | RFC-0006 | ✅     |

## Tools

| #   | Subsystem          | Package                 | RFC      | Status |
| --- | ------------------ | ----------------------- | -------- | ------ |
| 8   | Filesystem Tools   | `@hermes/tools-fs`      | RFC-0007 | ✅     |
| 9   | Shell Tools        | `@hermes/tools-shell`   | RFC-0008 | ✅     |
| 10  | HTTP Tools         | `@hermes/tools-http`    | —        | 🔜     |
| 11  | Git Tools          | `@hermes/tools-git`     | —        | ⬜     |
| 12  | GitHub Integration | `@hermes/tools-github`  | —        | ⬜ 🔑  |
| 13  | Browser Automation | `@hermes/tools-browser` | —        | ⬜ 🔑  |

## Models

Every provider implements `@hermes/model`'s contracts, so each can be built and
tested against a fake before a key exists — only _live_ verification needs one.

| #   | Subsystem         | Package                      | Status               |
| --- | ----------------- | ---------------------------- | -------------------- |
| 14  | Embedding Service | `@hermes/embedding`          | ⬜                   |
| 15  | Model Router      | `@hermes/model-router`       | ⬜                   |
| 16  | Ollama Provider   | `@hermes/provider-ollama`    | ⬜ 🔑 (local server) |
| 17  | Claude Provider   | `@hermes/provider-anthropic` | ⬜ 🔑                |
| 18  | OpenAI Provider   | `@hermes/provider-openai`    | ⬜ 🔑                |
| 19  | Gemini Provider   | `@hermes/provider-google`    | ⬜ 🔑                |
| 20  | Context Builder   | `@hermes/context`            | ⬜                   |

## Runtime & interfaces

| #   | Subsystem            | Status |
| --- | -------------------- | ------ |
| 21  | Background Scheduler | ⬜     |
| 22  | Worker Runtime       | ⬜     |
| 23  | Telegram Interface   | ⬜ 🔑  |
| 24  | REST API             | ⬜     |
| 25  | CLI                  | ⬜     |

## Platform

| #   | Subsystem      | Status |
| --- | -------------- | ------ |
| 26  | Authentication | ⬜     |
| 27  | Authorization  | ⬜     |
| 28  | Plugin SDK     | ⬜     |
| 29  | Plugin Loader  | ⬜     |
| 30  | Configuration  | ⬜     |
| 31  | Secrets        | ⬜     |
| 32  | Observability  | ⬜     |
| 33  | Metrics        | ⬜     |
| 34  | Tracing        | ⬜     |
| 35  | Health Checks  | ⬜     |

## Production

| #   | Subsystem                | Status |
| --- | ------------------------ | ------ |
| 36  | Docker Production        | ⬜     |
| 37  | CI/CD                    | ⬜     |
| 38  | Security Audit           | ⬜     |
| 39  | Load Testing             | ⬜     |
| 40  | Performance Optimization | ⬜     |
| 41  | Production Documentation | ⬜     |

## Credential-gated work

The 🔑 items can be **fully built and tested against fakes** — interfaces,
adapters, clients, and comprehensive tests all ship. Only live verification
against the real service is deferred, and each documents exactly which
credential it needs and what remains to confirm. See STATUS.md for current
detail.
