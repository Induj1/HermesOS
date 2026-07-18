# HermesOS

A personal operating system for agents — a production-grade, composable runtime
for autonomous AI, built as a TypeScript/pnpm monorepo.

HermesOS is a **kernel** that runs a graph of tasks toward a goal, and a set of
**composable subsystems** — models, tools, memory, scheduling, observability,
and interfaces — that plug into it. Every subsystem is strongly typed,
deterministic (a pure function of injected clocks and transports), tested to
≥95% branch coverage, and documented by an RFC.

## Status

**HermesOS 1.0.0.** 40 of 41 roadmap items are built and the repository is fully
green (lint, typecheck, build, format, and per-package coverage thresholds). The
one open item is the dedicated Ollama-native provider (#16), deferred — Ollama
already works today through the OpenAI-compatible provider. See
[STATUS.md](STATUS.md) for the full picture, [ROADMAP.md](ROADMAP.md) for the
plan, and [RELEASE_NOTES.md](RELEASE_NOTES.md) / [CHANGELOG.md](CHANGELOG.md)
for the release. Licensed under [MIT](LICENSE).

## Quick start

```bash
git clone https://github.com/<org>/HermesOS.git
cd HermesOS
pnpm install
pnpm build
pnpm test        # ~2465 tests
```

`pnpm lint`, `pnpm typecheck`, and `pnpm format:check` round out the gate CI
runs. For the full contributor setup (native Postgres/Redis/Ollama via
`just setup`), see [CONTRIBUTING.md](CONTRIBUTING.md).

### Run the API service

```bash
pnpm --filter @hermes/api build
PORT=3000 node apps/api/dist/main.js
curl http://127.0.0.1:3000/livez     # { "status": "healthy", ... }
```

`GET /` (identity), `/livez`, `/readyz`, and `/metrics` (Prometheus) are served.
See [apps/api](apps/api/README.md) and
[docs/deployment](docs/deployment/README.md).

### The CLI

`@hermes/cli` is a **framework** for building command-line tools (schema-less
arg parsing, command dispatch, injected IO), not a shipped binary — an app wires
its own commands. See [packages/cli](packages/cli/README.md).

## Architecture

The build follows the dependency graph, tier by tier:

| Tier                     | What                           | Examples                                                        |
| ------------------------ | ------------------------------ | --------------------------------------------------------------- |
| **Foundations**          | The kernel and core contracts  | `@hermes/kernel`, `@hermes/model`, `@hermes/tools`              |
| **Tools**                | Sandboxed capabilities         | fs, shell, http, git, github, browser                           |
| **Models**               | Provider-agnostic model access | embedding, router, OpenAI/Anthropic/Gemini providers, context   |
| **Runtime & interfaces** | Execution and surfaces         | scheduler, worker, REST, CLI, Telegram                          |
| **Platform**             | Cross-cutting infrastructure   | config, secrets, auth, authz, plugins, metrics, tracing, health |
| **Production**           | Deployable and operable        | `apps/api`, Docker, CI/CD, load testing, docs                   |

Each subsystem has an RFC under [docs/rfcs](docs/rfcs) (RFC-0001 … RFC-0036).

## Design principles

- **Ports and adapters.** Every external dependency (a clock, a transport, a
  sink, a store) is an injected interface with a deterministic fake, so no test
  touches a real network or wall clock.
- **Zero-dependency cores.** Most packages have no runtime dependencies; the
  only non-`@hermes/*` runtime dependency in the whole monorepo is `pg`.
- **Fail closed.** Authorization is default-deny; secrets redact by
  construction; a corrupt inbound header starts fresh rather than trusting a
  forged value.

## Documentation

- [STATUS.md](STATUS.md) · [ROADMAP.md](ROADMAP.md) — what is built and planned.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, workflow, conventions.
- [docs/rfcs](docs/rfcs) — a design record per subsystem.
- [docs/deployment](docs/deployment/README.md) — build, run, and operate.
- [docs/security/audit.md](docs/security/audit.md) ·
  [SECURITY_REVIEW.md](SECURITY_REVIEW.md) · [SECURITY.md](SECURITY.md) —
  security posture and disclosure.
- [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md) — the credential-gated
  integration checklist.

## License

See [LICENSE](LICENSE).
