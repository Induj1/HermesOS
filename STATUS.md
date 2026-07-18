# HermesOS Status

A running account of what is built, what is verified, and what is blocked.
Updated after each subsystem. For the ordered plan, see ROADMAP.md.

## At a glance

- **25 subsystems complete** (incl. shared `provider-http`, `worker`, `rest`,
  `metrics`), each with an RFC, a README, and enforced ≥95% test coverage.
- **2212 tests** pass repo-wide (23 packages + 4 services). Lint, typecheck,
  build, and format are clean.
- **The model tier is complete** (#14–20): embedding platform, router, and the
  OpenAI/Ollama, Anthropic, and Gemini providers — all verified against
  high-fidelity fakes, with only live API calls left. **The runtime tier is
  underway**: scheduler (#21), worker (#22), and the REST layer (#24) are done;
  metrics (#33) lands the first observability piece.
- **Remaining:** CLI (#25), Telegram (#23, gated), and plugin SDK/loader
  (#28–29) — then the Production tier (#36–41, scoped in
  `docs/architecture/production-tier.md`). The **platform tier is nearly
  complete**: config (#30), secrets (#31), observability (#32), metrics (#33),
  tracing (#34), health (#35), authentication (#26), and authorization (#27) all
  ship. None are blocked; each is buildable against fakes.
- **Tracked consolidation:** the cancellable-`sleep` helper is duplicated in
  `@hermes/embedding` and `@hermes/tools-github`; the worker now uses the
  kernel's `Clock` instead. Refactoring the other two would change their public
  `sleep` option, so it is deferred as a deliberate, low-risk cleanup rather
  than done at session end.

## Complete

| Subsystem        | Package                      | Tests | Notes                                                                        |
| ---------------- | ---------------------------- | ----- | ---------------------------------------------------------------------------- |
| Kernel           | `@hermes/kernel`             | 161   | Zero-dependency runtime: missions, tasks, scheduler, event bus.              |
| Memory           | `@hermes/memory`             | 304   | Postgres-backed; pgvector-ready; conversation/record/mission.                |
| Planner          | `@hermes/planner`            | 201   | Goal → validated plan → `MissionSpec`. Strategy chain, replanner.            |
| Execution Engine | `@hermes/execution`          | 197   | Runs plans; `$from` data flow; checkpoints; pause/resume.                    |
| Agent Framework  | `@hermes/agent`              | 172   | Decide-never-execute; reasoners; sessions; delegation.                       |
| Model Contracts  | `@hermes/model`              | 42    | Provider interfaces; zero dependencies.                                      |
| Tool Framework   | `@hermes/tools`              | 175   | Self-describing tools; schemas; permissions; discovery.                      |
| Filesystem Tools | `@hermes/tools-fs`           | 104   | Rooted, cancellable; port + Node + memory implementations.                   |
| Shell Tools      | `@hermes/tools-shell`        | 46    | Argv-not-shell; allowlist; timeout/output caps; env isolation.               |
| HTTP Tools       | `@hermes/tools-http`         | 92    | SSRF policy (pure); redirect re-checking; streaming size cap.                |
| Git Tools        | `@hermes/tools-git`          | 106   | Shell-executor reuse; structured porcelain reads; 3-grade perms.             |
| GitHub           | `@hermes/tools-github`       | 98    | REST+GraphQL over injected transport; auth/App/webhooks; fake server.        |
| Browser          | `@hermes/tools-browser`      | 99    | Playwright-shaped port; HTTP-backed fake browser; DOM engine; 3-grade perms. |
| Embedding        | `@hermes/embedding`          | 108   | Provider-independent platform: batching, retries, concurrency, cost; fakes.  |
| Model Router     | `@hermes/model-router`       | 44    | Capability selection + retryable-fallback across providers; scriptable fake. |
| OpenAI Provider  | `@hermes/provider-openai`    | 45    | Chat/tools + embeddings over OpenAI wire; Azure/Ollama/vLLM-compatible.      |
| Anthropic        | `@hermes/provider-anthropic` | 35    | Messages API chat/tools; system-hoist + block bridge; 529→retryable.         |
| Gemini           | `@hermes/provider-google`    | 24    | `generateContent` chat/tools; user/model + systemInstruction bridge.         |
| Context Builder  | `@hermes/context`            | 23    | Goal → packed `ModelMessage[]` within a token budget; deterministic.         |
| Provider Base    | `@hermes/provider-http`      | 22    | Shared transport + status→`ModelError` classification for every provider.    |
| Scheduler        | `@hermes/scheduler`          | 31    | Cron/interval/once triggers; pure `nextRun`; coalescing `poll`.              |
| Worker Runtime   | `@hermes/worker`             | 20    | Queue port + in-memory queue; claim/ack/retry/dead-letter; kernel `Clock`.   |
| REST Layer       | `@hermes/rest`               | 40    | Plain-data request/response; router; middleware; Node adapter.               |
| Metrics          | `@hermes/metrics`            | 19    | Counter/gauge/histogram with labels; Prometheus exposition; zero-dep.        |
| Configuration    | `@hermes/config`             | 34    | Typed schema over the environment; all-errors-at-once; secret redaction.     |
| Secrets          | `@hermes/secrets`            | 30    | Opaque `Secret` (leak-resistant); env/`NAME_FILE`/file/chain sources.        |
| Health           | `@hermes/health`             | 13    | Liveness/readiness checks; per-check timeout via `Clock`; worst-of report.   |
| Tracing          | `@hermes/tracing`            | 25    | Spans; W3C `traceparent` propagation; injected clock/ids; span exporter.     |
| Observability    | `@hermes/logger`             | 18    | Structured leveled logs; JSON sinks; secret-safe fields; trace correlation.  |
| Authentication   | `@hermes/auth`               | 25    | Principals; API-key/bearer credentials; constant-time compare; chain.        |
| Authorization    | `@hermes/authz`              | 20    | Wildcard scopes; deny-override, default-deny policy engine over principals.  |

## Production tier — defined, not yet built

The Production tier (#36–41) is scoped in
[`docs/architecture/production-tier.md`](docs/architecture/production-tier.md):
milestone number, package (most are repo-level artifacts, not packages),
responsibilities, dependencies, and completion criteria for each. In short —
**#36 Docker** (multi-stage image + Compose stack, config from the environment),
**#37 CI/CD** (the local gate suite run on every PR; image build on a tag),
**#38 Security Audit** (document each existing trust boundary → control →
residual risk, plus `pnpm audit`), **#39 Load Testing** (`@hermes/loadtest`, a
deterministic in-process harness over the REST app and worker), **#40
Performance Optimization** (measured, behaviour-preserving changes found via
#39), and **#41 Production Documentation** (deployment guide, config reference,
ops runbook, credential list). They depend on the platform tier (#25–35) landing
first.

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
- **Tool versioning is declared, not enforced** (RFC-0006 §7.3) — waits for the
  Plugin Loader, its first consumer.
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
