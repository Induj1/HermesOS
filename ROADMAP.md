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
| 10  | HTTP Tools         | `@hermes/tools-http`    | RFC-0009 | ✅     |
| 11  | Git Tools          | `@hermes/tools-git`     | RFC-0010 | ✅     |
| 12  | GitHub Integration | `@hermes/tools-github`  | RFC-0011 | ✅ 🔑  |
| 13  | Browser Automation | `@hermes/tools-browser` | RFC-0012 | ✅ 🔑  |

## Models

Every provider implements `@hermes/model`'s contracts, so each can be built and
tested against a fake before a key exists — only _live_ verification needs one.

| #   | Subsystem         | Package                      | Status               |
| --- | ----------------- | ---------------------------- | -------------------- |
| 14  | Embedding Service | `@hermes/embedding`          | ✅ (RFC-0013)        |
| 15  | Model Router      | `@hermes/model-router`       | ✅ (RFC-0014)        |
| 16  | Ollama Provider   | `@hermes/provider-ollama`    | 🔜 🔑 (local server) |
| 17  | Claude Provider   | `@hermes/provider-anthropic` | ✅ 🔑 (RFC-0016)     |
| 18  | OpenAI Provider   | `@hermes/provider-openai`    | ✅ 🔑 (RFC-0015)     |
| 19  | Gemini Provider   | `@hermes/provider-google`    | ✅ 🔑 (RFC-0019)     |
| 20  | Context Builder   | `@hermes/context`            | ✅ (RFC-0017)        |

## Runtime & interfaces

| #   | Subsystem            | Status           |
| --- | -------------------- | ---------------- |
| 21  | Background Scheduler | ✅ (RFC-0020)    |
| 22  | Worker Runtime       | ✅ (RFC-0021)    |
| 23  | Telegram Interface   | ✅ 🔑 (RFC-0034) |
| 24  | REST API             | ✅ (RFC-0022)    |
| 25  | CLI                  | ✅ (RFC-0033)    |

## Platform

| #   | Subsystem      | Status        |
| --- | -------------- | ------------- |
| 26  | Authentication | ✅ (RFC-0029) |
| 27  | Authorization  | ✅ (RFC-0030) |
| 28  | Plugin SDK     | ✅ (RFC-0031) |
| 29  | Plugin Loader  | ✅ (RFC-0032) |
| 30  | Configuration  | ✅ (RFC-0024) |
| 31  | Secrets        | ✅ (RFC-0025) |
| 32  | Observability  | ✅ (RFC-0028) |
| 33  | Metrics        | ✅ (RFC-0023) |
| 34  | Tracing        | ✅ (RFC-0027) |
| 35  | Health Checks  | ✅ (RFC-0026) |

## Production

| #   | Subsystem                | Status        |
| --- | ------------------------ | ------------- |
| 36  | Docker Production        | ⬜            |
| 37  | CI/CD                    | ⬜            |
| 38  | Security Audit           | ⬜            |
| 39  | Load Testing             | ✅ (RFC-0035) |
| 40  | Performance Optimization | ⬜            |
| 41  | Production Documentation | ⬜            |

Each Production milestone is defined explicitly — package (most are repo-level
artifacts, not packages), responsibilities, dependencies, and completion
criteria — in
[`docs/architecture/production-tier.md`](docs/architecture/production-tier.md).

## Credential-gated work

The 🔑 items can be **fully built and tested against fakes** — interfaces,
adapters, clients, and comprehensive tests all ship. Only live verification
against the real service is deferred, and each documents exactly which
credential it needs and what remains to confirm. See STATUS.md for current
detail.
