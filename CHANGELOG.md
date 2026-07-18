# Changelog

All notable changes to HermesOS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-07-18

First public release. HermesOS is a production-grade, composable runtime for
autonomous AI: a zero-dependency **kernel** that runs a graph of tasks toward a
goal, plus a set of composable subsystems that plug into it. Every subsystem is
strongly typed, deterministic (a pure function of injected clocks and
transports), tested to ≥95% branch coverage, and documented by an RFC (RFC-0001
… RFC-0036).

**40 of 41 roadmap items** ship. **2465 tests** pass; lint, typecheck, build,
format, coverage thresholds, and `pnpm audit` are all clean. Live-validated
against real infrastructure (Docker, Postgres + pgvector, Ollama, git, and the
reachable cloud endpoints) — see `PRODUCTION_CERTIFICATION.md`.

### Added

- **Foundations** — the kernel (missions, tasks, scheduler, event bus, plugins),
  model contracts, and the tool framework (`@hermes/kernel`, `@hermes/model`,
  `@hermes/tools`).
- **Tools** — filesystem, shell (argv-not-shell), HTTP (SSRF policy), git,
  GitHub (REST + GraphQL + App + webhooks), and a Playwright-shaped browser with
  a high-fidelity fake backend.
- **Models** — a provider-independent embedding platform, a capability router
  with retryable fallback, providers for OpenAI/Azure/vLLM, Anthropic, and
  Gemini (Ollama via the OpenAI-compatible endpoint), and a token-budget context
  builder.
- **Runtime & interfaces** — a background scheduler (cron/interval/once), a
  worker runtime, a framework-agnostic REST layer, a deterministic CLI
  framework, and a Telegram bot interface.
- **Platform** — configuration, secrets (leak-resistant), authentication,
  authorization (default-deny), a versioned plugin SDK + compatibility-enforcing
  loader, metrics (Prometheus), tracing (W3C `traceparent`), structured logging,
  and health checks.
- **Production** — the `@hermes/api` composition-root service, a multi-stage
  Docker image + Compose profile, GitHub Actions CI and release workflows, a
  security audit, a deterministic load-test harness, and deployment
  documentation.
- Persistence via `@hermes/memory` (Postgres, pgvector, brute-force fallback,
  hybrid retrieval).
- MIT license.

### Security

- SSRF policy re-checked on every redirect; argv-not-shell command execution;
  path rooting without TOCTOU; constant-time credential/signature comparison;
  default-deny, deny-override authorization; secret redaction by construction;
  crypto-quality randomness for ids and trace/span identifiers.
- `git clone` rejects git remote-helper transport URLs (`ext::…`) that would
  execute a command.
- `pnpm audit` reports no known vulnerabilities; wired into CI.

### Known limitations

- No dedicated native Ollama chat provider yet (#16); Ollama works through the
  OpenAI-compatible endpoint.
- No real Playwright backend adapter (the shaped port and fake ship); chat
  providers buffer rather than stream. See `PRODUCTION_CERTIFICATION.md` for the
  credential-gated integrations awaiting live keys.

[1.0.0]: https://github.com/hermesos/hermesos/releases/tag/v1.0.0
