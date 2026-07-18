# HermesOS Status

A running account of what is built, what is verified, and what is blocked.
Updated after each subsystem. For the ordered plan, see ROADMAP.md.

## At a glance

- **40 of the 41 roadmap items are built.** The one open item is the **dedicated
  Ollama-native provider (#16)**, marked 🔜 in ROADMAP and deferred: Ollama is
  already usable today through `@hermes/provider-openai` pointed at its
  OpenAI-compatible `/v1` endpoint, and a native provider needs a local Ollama
  server to verify. Every built subsystem has an RFC and enforced ≥95% branch
  coverage; the Production tier (#36–41) is built, with the composition-root API
  service (`apps/api`) wiring the platform together.
- **2465 tests** pass repo-wide (33 packages + 2 apps + 4 services). Lint,
  typecheck, build, format, and coverage thresholds are all clean.
- **Every tier is built** (bar Ollama #16 above): foundations (#1–7), tools
  (#8–13), models (#14–20), runtime & interfaces (#21–25), platform (#26–35),
  and production (#36–41).
- **Credential/infra-gated verification is what remains** — code-complete,
  fake-verified subsystems whose _live_ confirmation needs an external key or
  runtime: the three model providers (OpenAI, Anthropic, Gemini), git remote,
  GitHub, browser, Telegram, and Postgres (all in "Simulated / awaiting live
  verification"), plus the three Production steps that need infrastructure to
  _execute_ — the `docker build`/run (#36), the CI/CD workflow runs (#37), and
  the `pnpm audit` result (#38). See `LIVE_VERIFICATION.md`. None are code gaps.
- **Tracked near-duplications (deliberate, documented — not refactored):** each
  cluster below is small, correct, and locally tested; consolidating would
  couple packages (several are foundational and zero-dependency, e.g.
  `@hermes/kernel` and `@hermes/model`, which cannot depend on a shared package)
  for marginal DRY gain, so they are recorded rather than merged (the same
  judgment RFC-0010 §7 and the sleep note already apply):
  - `toError(thrown)` — 8 per-package public copies (tools, embedding, model,
    kernel, memory, planner, agent, execution). Kernel's uses a circular-safe
    stringify; the others use `String(thrown)` (identical for Error/string
    throws; differs only in the message for a non-Error object).
  - `messageOf(error)` — 3 private copies (tracing, health, telegram) plus
    inlined uses elsewhere.
  - The cancellable-`sleep` helper (`@hermes/embedding`,
    `@hermes/tools-github`); a 6-line pure-JS `constantTimeEqual`
    (`@hermes/auth`, `@hermes/telegram`; `@hermes/tools-github` uses
    `crypto.timingSafeEqual` for HMAC — a distinct primitive); a `retry-after`
    parser and a case-insensitive header lookup (2 copies each).

## Complete

| Subsystem        | Package                      | Tests | Notes                                                                               |
| ---------------- | ---------------------------- | ----- | ----------------------------------------------------------------------------------- |
| Kernel           | `@hermes/kernel`             | 161   | Zero-dependency runtime: missions, tasks, scheduler, event bus.                     |
| Memory           | `@hermes/memory`             | 304   | Postgres-backed; pgvector-ready; conversation/record/mission.                       |
| Planner          | `@hermes/planner`            | 201   | Goal → validated plan → `MissionSpec`. Strategy chain, replanner.                   |
| Execution Engine | `@hermes/execution`          | 197   | Runs plans; `$from` data flow; checkpoints; pause/resume.                           |
| Agent Framework  | `@hermes/agent`              | 172   | Decide-never-execute; reasoners; sessions; delegation.                              |
| Model Contracts  | `@hermes/model`              | 42    | Provider interfaces; zero dependencies.                                             |
| Tool Framework   | `@hermes/tools`              | 175   | Self-describing tools; schemas; permissions; discovery.                             |
| Filesystem Tools | `@hermes/tools-fs`           | 104   | Rooted, cancellable; port + Node + memory implementations.                          |
| Shell Tools      | `@hermes/tools-shell`        | 46    | Argv-not-shell; allowlist; timeout/output caps; env isolation.                      |
| HTTP Tools       | `@hermes/tools-http`         | 92    | SSRF policy (pure); redirect re-checking; streaming size cap.                       |
| Git Tools        | `@hermes/tools-git`          | 109   | Shell-executor reuse; structured reads; 3-grade perms; clone-URL transport guard.   |
| GitHub           | `@hermes/tools-github`       | 98    | REST+GraphQL over injected transport; auth/App/webhooks; fake server.               |
| Browser          | `@hermes/tools-browser`      | 99    | Playwright-shaped port; HTTP-backed fake browser; DOM engine; 3-grade perms.        |
| Embedding        | `@hermes/embedding`          | 108   | Provider-independent platform: batching, retries, concurrency, cost; fakes.         |
| Model Router     | `@hermes/model-router`       | 44    | Capability selection + retryable-fallback across providers; scriptable fake.        |
| OpenAI Provider  | `@hermes/provider-openai`    | 45    | Chat/tools + embeddings over OpenAI wire; Azure/Ollama/vLLM-compatible.             |
| Anthropic        | `@hermes/provider-anthropic` | 35    | Messages API chat/tools; system-hoist + block bridge; 529→retryable.                |
| Gemini           | `@hermes/provider-google`    | 24    | `generateContent` chat/tools; user/model + systemInstruction bridge.                |
| Context Builder  | `@hermes/context`            | 23    | Goal → packed `ModelMessage[]` within a token budget; deterministic.                |
| Provider Base    | `@hermes/provider-http`      | 22    | Shared transport + status→`ModelError` classification for every provider.           |
| Scheduler        | `@hermes/scheduler`          | 31    | Cron/interval/once triggers; pure `nextRun`; coalescing `poll`.                     |
| Worker Runtime   | `@hermes/worker`             | 20    | Queue port + in-memory queue; claim/ack/retry/dead-letter; kernel `Clock`.          |
| REST Layer       | `@hermes/rest`               | 40    | Plain-data request/response; router; middleware; Node adapter.                      |
| Metrics          | `@hermes/metrics`            | 19    | Counter/gauge/histogram with labels; Prometheus exposition; zero-dep.               |
| Configuration    | `@hermes/config`             | 34    | Typed schema over the environment; all-errors-at-once; secret redaction.            |
| Secrets          | `@hermes/secrets`            | 30    | Opaque `Secret` (leak-resistant); env/`NAME_FILE`/file/chain sources.               |
| Health           | `@hermes/health`             | 13    | Liveness/readiness checks; per-check timeout via `Clock`; worst-of report.          |
| Tracing          | `@hermes/tracing`            | 25    | Spans; W3C `traceparent` propagation; injected clock/ids; span exporter.            |
| Observability    | `@hermes/logger`             | 18    | Structured leveled logs; JSON sinks; secret-safe fields; trace correlation.         |
| Authentication   | `@hermes/auth`               | 25    | Principals; API-key/bearer credentials; constant-time compare; chain.               |
| Authorization    | `@hermes/authz`              | 20    | Wildcard scopes; deny-override, default-deny policy engine over principals.         |
| Plugin SDK       | `@hermes/plugin-sdk`         | 4     | Versioned manifest + `definePlugin` over the kernel `PluginContext`.                |
| Plugin Loader    | `@hermes/plugin-loader`      | 18    | Enforces API-version compat; validates manifests; adapts to kernel plugins.         |
| CLI              | `@hermes/cli`                | 22    | Schema-less arg parsing; command dispatch; injected IO; returns exit code.          |
| Telegram         | `@hermes/telegram`           | 32    | Bot API client; command dispatch; webhook verify; fake server. 🔑 (live).           |
| Load Testing     | `@hermes/loadtest`           | 14    | Deterministic harness: bounded concurrency, latency percentiles, throughput.        |
| API service      | `@hermes/api` (`apps/api`)   | 12    | Composition root: config+logger+health+metrics+REST; `/livez`,`/readyz`,`/metrics`. |

## Production tier — complete (#36–41)

Scoped in
[`docs/architecture/production-tier.md`](docs/architecture/production-tier.md)
and recorded in [RFC-0036](docs/rfcs/RFC-0036-production.md) (#39 has its own
RFC-0035):

- **#36 Docker** — a two-stage `Dockerfile` (`pnpm deploy`-isolated runtime, no
  secrets baked in, non-root, `/livez` `HEALTHCHECK`) plus an `app`-profile
  service in `docker-compose.yml`, running the `apps/api` composition root.
- **#37 CI/CD** — `.github/workflows/ci.yml` runs the full gate (lint,
  typecheck, build, `test:coverage`) on every PR; `release.yml` builds/pushes
  the image on a `v*` tag.
- **#38 Security Audit** — `docs/security/audit.md`: 13 trust boundaries →
  control → residual risk, plus the `pnpm audit` action.
- **#39 Load Testing** — `@hermes/loadtest` (14 tests, RFC-0035).
- **#40 Performance** — `docs/architecture/performance.md`: the measure-first
  method and candidate hot paths (no fabricated numbers; the instrumentation
  ships).
- **#41 Production Documentation** — `docs/deployment/README.md`: build/run,
  config reference, ops runbook, credential list.

**Infra-gated (🔧):** the `docker build`/run, the CI workflow runs, and the
`pnpm audit` result are authored and correct but need a Docker daemon / hosted
runner / CI to _execute_ — the analogue of a credential-gated subsystem needing
a key. None are code gaps.

## Simulated / awaiting live verification

- **Git remote operations** (`@hermes/tools-git`) — `clone`, `fetch`, `pull`,
  and `push` are implemented and unit-tested against `FakeGitExecutor` (argv and
  result-shaping, including a rejected-push report). The full local lifecycle is
  verified against **real git** in `integration.test.ts`. What is _not_ covered:
  a live round-trip to an authenticated remote, which needs a credential (an SSH
  key, a token, or a credential helper) the build does not have. **To confirm
  live:** point `push`/`pull` at a real credentialed remote and assert the
  transfer. See RFC-0010 §10.

- **GitHub Integration** (`@hermes/tools-github`) — the REST and GraphQL
  clients, the auth abstraction (PAT, unauthenticated, and the GitHub App JWT →
  installation-token flow), pagination, retries, rate-limit handling, webhook
  signature verification, and the repository/issue/PR/workflow/release facade
  are **all implemented and verified against `FakeGitHubServer`** (98 tests,
  contract tests included). What needs a credential to confirm live: (1) a real
  REST/GraphQL round-trip against `api.github.com` with a **personal access
  token**; (2) the **GitHub App** flow end to end — a real App ID and RSA
  private key signing a JWT GitHub accepts, exchanged for an installation token;
  (3) a real signed **webhook** delivery from GitHub. **To confirm live:**
  supply a `FetchHttpClient` and a token (and, for the App and webhook, an App
  key and a configured webhook secret). None are code gaps — see RFC-0011 §9.

- **Browser Automation** (`@hermes/tools-browser`) — the Playwright-shaped port,
  the session, all the tools, and a high-fidelity `FakeBrowser` are
  **implemented and verified** (99 tests). The fake fetches page content through
  the shared HTTP layer, so navigation, redirects, SSRF policy, and network
  failures are genuinely exercised. What needs a **real browser runtime** to
  confirm: a `PlaywrightBrowser` backend implementing the same port over
  Chromium, plus the JavaScript-driven behaviour the fake approximates with its
  `data-fk-*` protocol (real CSS visibility, live DOM mutation, real
  dialogs/downloads). **To confirm live:** implement `PlaywrightBrowser` and run
  the tool suite against it. Not a code gap in the port or tools — see RFC-0012
  §8.

- **Embedding Service** (`@hermes/embedding`) — the whole platform (batching,
  bounded concurrency, retries with backoff, deterministic ordering,
  cancellation and timeout, normalization, usage/cost, capability negotiation)
  is **implemented and verified** against `FakeEmbeddingProvider` (108 tests).
  The `HttpEmbeddingProvider` base is verified against a fake HTTP client with
  an OpenAI-shaped subclass. What needs a **real embedding provider** to
  confirm: concrete providers (#16–18) implementing
  `buildRequest`/`parseResponse` against the real wire format, with live auth,
  rate-limit headers, and error bodies — and the full chain (provider → service
  → `toModelEmbedding` → `MemoryService`) storing real vectors. **To confirm
  live:** implement a provider and supply a key or a local server. Not a
  platform gap — see RFC-0013 §12.

- **OpenAI Provider** (`@hermes/provider-openai`) — chat/tool-calling and
  embeddings over the OpenAI wire format are **implemented and verified**
  against a fake HTTP client (45 tests): message/tool/response mapping, the full
  status/transport error classification, and embeddings end to end through the
  `EmbeddingService`. The same package targets Azure, Ollama's `/v1`, and vLLM
  by `baseUrl`. What needs a live **`OPENAI_API_KEY`** (or a compatible
  endpoint): confirming the request shape and error bodies match live OpenAI,
  and a real chat/embedding round-trip. Streaming is intentionally unimplemented
  until the transport supports it. Not a code gap — see RFC-0015 §8.

- **Anthropic Provider** (`@hermes/provider-anthropic`) — chat/tool-calling over
  the Messages API is **implemented and verified** against a fake HTTP client
  (35 tests): the system-hoist + content-block + role-coalescing message bridge,
  the full request shaping and `tool_choice` mapping, response parsing, and the
  status/transport error classification (incl. `529` overloaded → retryable).
  What needs a live **`ANTHROPIC_API_KEY`**: confirming the wire shape and error
  bodies match live Anthropic and a real (multi-tool) round-trip. No embedding
  API; streaming unimplemented until the transport supports it. See RFC-0016 §5.

- **Gemini Provider** (`@hermes/provider-google`) — chat/tool-calling over the
  `generateContent` API is **implemented and verified** against a fake HTTP
  client (24 tests): the user/model-role + systemInstruction + parts bridge
  (incl. the tool-result name-vs-id fallback and role coalescing), request
  shaping and `functionCallingConfig` mapping, response parsing, and the
  shared-classifier wiring (incl. the context-length override). What needs a
  live **`GEMINI_API_KEY`**: confirming the wire shape and a real round-trip.
  Chat/tools only; streaming unimplemented. See RFC-0019 §4.

- **Telegram Interface** (`@hermes/telegram`) — the Bot API client, the
  command/text dispatcher, the long-poll loop (clock-driven), and webhook
  verification are **implemented and verified** against `FakeTelegramServer` (32
  tests): `getMe`/`sendMessage`/`getUpdates` over the real envelope, offset
  acknowledgement, error classification (bad token, transport failure,
  non-JSON), and the constant-time webhook secret check. The client reuses the
  shared `HttpClient`, and errors never include the token-bearing URL. What
  needs a live **bot token**: a real `api.telegram.org` round-trip (wire shape,
  error bodies) and a genuine signed webhook delivery. Not a code gap — supply a
  `FetchHttpClient` and a token. See RFC-0034 §6.

The remaining rows fill in as further credential-gated subsystems are built:
each lists what is implemented, what is exercised against a fake, the exact
credential required, and what remains to confirm live.

## Known limitations carried forward

These are documented in the relevant RFCs and are deliberate, not defects:

- **Steps cannot exchange data through the kernel** (RFC-0001 §11.4) — closed by
  the execution engine's `$from` references (RFC-0004).
- **A session inside a kernel task is invisible to the scheduler** (RFC-0005
  §7.4) — inherited from RFC-0001 §11.3; use a `PlanDecision` for scheduler
  visibility.
- **Filesystem symlinks are reported, not resolved** (RFC-0007 §7.1) — rooting
  is airtight for path strings, best-effort for links.
- ~~**Tool versioning is declared, not enforced** (RFC-0006 §7.3)~~ — **closed**
  by the Plugin Loader (#29, RFC-0032): a plugin declares the API version it
  targets and the loader enforces semver compatibility before the kernel runs
  its `setup`.
- **Path confinement is duplicated** between `@hermes/tools-fs` and
  `@hermes/tools-git` (RFC-0010 §7) — a deliberate choice over coupling git to
  the filesystem tools package; it graduates to a shared utility at the third
  consumer (rule of three).
- **The embedding platform does not tokenize** (RFC-0013 §13) — `maxInputTokens`
  is advisory; it does not pre-split an over-long text, and normalization is L2
  only. A provider surfaces an over-length input as `INVALID_REQUEST`.
- **The browser DOM engine is a subset** (RFC-0012 §9) — no HTML5 implicit
  closing, a limited CSS grammar, and text nodes fold into their parent; the
  fake runs no JavaScript (behaviours use a `data-fk-*` protocol). A real
  Playwright backend removes these limits.
- **Git failure classification is best-effort** (RFC-0010 §6) — it keys on git's
  human-facing message strings; the exit code and raw output are always carried
  so a caller need not trust the derived code.

## Verification

Every commit passes
`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm format`.
Coverage thresholds (95% lines/branches/functions/statements) are enforced per
package in `vitest.config.ts`, so a drop fails CI rather than being noticed
later.
