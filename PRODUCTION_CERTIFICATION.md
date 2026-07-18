# HermesOS — Production Certification

Live validation against real infrastructure, performed as a senior platform
engineer. This certifies what was verified end-to-end, what remains gated on an
external dependency, and the production-readiness verdict.

## Verdict

## ✅ READY WITH MINOR CAVEATS

Every integration that could be exercised against real infrastructure
**passed**. Two genuine defects were discovered during live verification and
**fixed** (the Docker image would not build; a brittle test). No code defect
remains open. The caveats are external, not code: the happy-path of the
credential-gated cloud APIs needs real keys, the browser has no real backend yet
(documented future work), the GitHub-hosted CI/release runs need GitHub's
infrastructure, and the `LICENSE` file is empty (an owner decision that blocks a
public tag).

## Environment used

| Component                     | Available | Detail                                                                                                    |
| ----------------------------- | :-------: | --------------------------------------------------------------------------------------------------------- |
| Node / pnpm / git             |    ✅     | Node 25.5.0, pnpm 11.13.1, git 2.55.0                                                                     |
| Docker daemon                 |    ✅     | image build + run + compose verified                                                                      |
| Postgres                      |    ✅     | 17.10 (Homebrew) on 127.0.0.1:5432                                                                        |
| pgvector / pg_trgm            |    ✅     | installed during validation (`brew install pgvector`)                                                     |
| Ollama                        |    ✅     | server up; pulled `qwen2.5:0.5b` (chat), `all-minilm` (embeddings)                                        |
| Network egress                |    ✅     | api.openai.com / api.anthropic.com / generativelanguage / api.github.com / api.telegram.org all reachable |
| API credentials               |    ❌     | OpenAI, Anthropic, Gemini, GitHub, Telegram — all unset                                                   |
| Playwright                    |    ❌     | not installed; **and no real backend adapter exists in code**                                             |
| GitHub Actions runner / `act` |    ❌     | cannot execute workflows locally                                                                          |

## Defects found and fixed during validation

1. **Docker image would not build** (`fix(docker)`, commit `4081d8f`).
   `pnpm v10+` refuses `pnpm deploy` for a non-injected workspace
   (`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`). Added `--legacy`. Re-verified: the
   image builds, runs non-root, and answers all endpoints.
2. **Brittle memory test** (`test(memory)`, commit `61bb3a1`). Asserted the
   "stored without an embedding" warning at `warnings[0]`, but with pgvector
   present a semantic-index warning precedes it. Matched by content instead; the
   production behaviour was already correct.

## Integration results

### 1. OpenAI — PASS (auth path) / BLOCKED (happy path)

- **Environment:** live `api.openai.com`, no key.
- **Command:**
  `OpenAIChatModel({ client: OpenAIClient({ http: FetchHttpClient, apiKey: 'sk-bogus…' }) }).chat([user('hi')])`.
- **Evidence:** live 401 → `AuthenticationFailedError` `AUTHENTICATION_FAILED`
  `retryable=false` "Incorrect API key provided" (1804 ms). Invalid-key
  classification confirmed against the real API.
- **Limitation:** chat, embeddings, retries, and rate-limit handling need a
  valid `OPENAI_API_KEY` (fake-verified in the suite; not exercised live).

### 2. Anthropic — PASS (failure path) / BLOCKED (happy path)

- **Environment:** live `api.anthropic.com`, no key.
- **Evidence:** live 401 → `AuthenticationFailedError` "anthropic rejected the
  credentials: invalid x-api-key" (505 ms). Malformed-response handling is
  fake-verified (a real API does not return malformed bodies on demand).
- **Limitation:** chat needs `ANTHROPIC_API_KEY`.

### 3. Gemini — PASS (auth path) / BLOCKED (happy path)

- **Environment:** live `generativelanguage.googleapis.com`, no key.
- **Evidence:** live → `InvalidRequestError` "API key not valid" (210 ms).
- **Behavioural note:** Gemini returns **HTTP 400** for a bad key (not 401/403),
  so it classifies as `INVALID_REQUEST`, not `AUTHENTICATION_FAILED`. Faithful
  to the wire; a caller keying on `AUTHENTICATION_FAILED` to detect a bad Gemini
  key would miss it. Documented, not a defect.
- **Limitation:** generation and safety responses need `GEMINI_API_KEY`.

### 4. Ollama — PASS (real, both paths tested)

- **Environment:** local Ollama server, models `qwen2.5:0.5b` and `all-minilm`.
- **OpenAI-compatible chat** (`@hermes/provider-openai` → `127.0.0.1:11434/v1`):
  PASS — "6 × 7" → `"42"`, usage prompt=39/completion=3 (1490 ms).
- **Native embeddings** (`OllamaEmbeddingProvider` → `/api/embed`, all-minilm):
  PASS — 2 × 384-dim vectors, sensible cosine similarity (8425 ms, cold).
- **Behavioural note:** the OpenAI-compat response leaves `finishReason`
  `undefined` (Ollama does not populate `finish_reason` like OpenAI).
- **Limitation:** there is **no native Ollama chat provider** (#16 unbuilt); the
  OpenAI-compatible path is the only chat route (and works).

### 5. Git — PASS (real, full lifecycle)

- **Environment:** real `git` 2.55, a temporary bare repo as the remote.
- **Command:** the actual `@hermes/tools-git` tools over `ShellGitExecutor`.
- **Evidence:**
  `clone → add → commit → branch → checkout → merge → push → fetch` all PASS;
  the bare remote received the merge (2 commits) — 236 ms total. Plus the
  10-test real-git integration suite, and the clone-URL transport guard
  (`ext::…` rejected).
- **Limitation:** an authenticated push to a hosted remote needs a credential
  (the local bare-repo path is fully exercised).

### 6. GitHub — PASS (REST/GraphQL reachable + auth) / BLOCKED (authenticated ops)

- **Environment:** live `api.github.com`, no token.
- **Evidence:** unauthenticated REST fetched `octocat/Hello-World`
  (name/owner/id, 437 ms); a bogus token →
  `GitHubError UNAUTHORIZED 401 "Bad credentials"` on **both REST and GraphQL**
  (229 / 296 ms).
- **Limitation:** PAT-authenticated REST/GraphQL, the GitHub App JWT flow, and a
  real signed webhook need credentials (all fake-verified, 98 tests).

### 7. Playwright / Browser — BLOCKED (by design, not a defect)

- **Environment:** Playwright not installed.
- **Finding:** the codebase ships a Playwright-**shaped port** and a
  high-fidelity `FakeBrowser` (99 tests), but **no real `PlaywrightBrowser`
  adapter** — the real backend is documented future work (RFC-0012 §8).
  Screenshots, downloads, uploads, cookies, navigation, and dialogs are verified
  against the fake.
- **Limitation:** a real browser backend must be implemented before live browser
  verification is possible. Not implemented here (no new features).

### 8. Telegram — PASS (auth path + secret safety) / BLOCKED (real bot)

- **Environment:** live `api.telegram.org`, no bot token.
- **Evidence:** bogus token → `TelegramError 401 "Unauthorized"` (584 ms), and
  the **token does not appear in the error** (leak-safety confirmed live).
- **Limitation:** connecting a real bot and verifying commands/messaging needs a
  token from @BotFather (fake-server-verified, 32 tests).

### 9. Postgres + pgvector — PASS (real)

- **Environment:** Postgres 17.10 with `pgvector`, `pg_trgm`, `pgcrypto`,
  `citext`.
- **Command:** `DATABASE_URL=… pnpm --filter @hermes/memory test`.
- **Evidence:** **304 integration tests pass, 1 skipped** — real migrations
  (idempotent, drift-detecting), embedding storage, and similarity search on
  both the brute-force and the **pgvector HNSW** paths.
- **Note:** the extensions are provisioned by `infrastructure/postgres/init`
  (via `just db-init`); a database missing them fails migration `0002` — a
  documented prerequisite, not a code defect.

### 10. Docker image — PASS (real)

- **Command:** `docker build -t hermes-api .` then `docker run`.
- **Evidence:** builds in ~16 s → 348 MB; container runs as **non-root (uid 1000
  node)**; `/`, `/livez`, `/readyz`, `/metrics` all return 200 (~1.5 ms);
  container `HEALTHCHECK` reports **healthy**; structured JSON logs.

### 11. Docker Compose — PASS (real)

- **Command:** `docker compose --profile app up -d --build`.
- **Evidence:** the `api` service builds and starts, reaches **healthy**, binds
  `127.0.0.1:<port>→3000`, all endpoints 200, clean `down`.
  `docker compose config` validates.

### 12. GitHub Actions (`ci.yml`) — VERIFIED-EQUIVALENT (hosted run BLOCKED)

- **Finding:** no runner / `act` available. Every step the workflow runs was
  executed locally and **passes**: Lint, Prettier, Typecheck, Build,
  `test:coverage` (per-package ≥95% thresholds met), and `pnpm audit --prod` (no
  vulnerabilities). 2465 tests.
- **Limitation:** actual execution on a GitHub-hosted runner is unverified
  (needs GitHub infrastructure).

### 13. Release workflow (`release.yml`) — VERIFIED-EQUIVALENT (publish BLOCKED)

- **Finding:** its load-bearing step — the Docker image build — is verified
  PASS.
- **Limitation:** building/pushing to GHCR on a `v*` tag needs a hosted runner
  and the ambient `GITHUB_TOKEN`; not executable here.

## Summary table

| Integration                                | Verdict                                        | Live? |
| ------------------------------------------ | ---------------------------------------------- | ----- |
| OpenAI                                     | PASS (auth) · BLOCKED (happy path)             | ✅    |
| Anthropic                                  | PASS (auth) · BLOCKED (happy path)             | ✅    |
| Gemini                                     | PASS (auth) · BLOCKED (happy path)             | ✅    |
| Ollama (OpenAI-compat + native embeddings) | **PASS**                                       | ✅    |
| Git (clone/fetch/branch/merge/push)        | **PASS**                                       | ✅    |
| GitHub (REST/GraphQL + auth)               | PASS · BLOCKED (PAT/App/webhook)               | ✅    |
| Playwright / browser                       | BLOCKED (no backend, by design)                | ❌    |
| Telegram                                   | PASS (auth + leak-safety) · BLOCKED (real bot) | ✅    |
| Postgres + pgvector                        | **PASS**                                       | ✅    |
| Docker image                               | **PASS**                                       | ✅    |
| Docker Compose                             | **PASS**                                       | ✅    |
| GitHub Actions                             | VERIFIED-EQUIVALENT · hosted run BLOCKED       | ⚠️    |
| Release workflow                           | VERIFIED-EQUIVALENT · publish BLOCKED          | ⚠️    |

## Architecture summary

- **33 packages + 2 apps + 4 services**, 36 RFCs. Ports/adapters throughout;
  every external dependency is an injected interface with a deterministic fake.
- **One non-`@hermes/*` runtime dependency in the whole monorepo** (`pg`).
- **2465 tests**, all gates green; per-package ≥95% branch coverage enforced.
- Security: argv-not-shell, path rooting, SSRF re-checked on every redirect,
  constant-time credential/signature comparison, default-deny authz, secret
  redaction — all verified in the earlier audit and `pnpm audit` clean.

## Known limitations (external, non-blocking for code)

1. Cloud-API happy paths (OpenAI/Anthropic/Gemini chat & embeddings, GitHub
   authenticated ops, a real Telegram bot) need credentials — only the
   auth-failure paths were exercised live.
2. No real Playwright backend adapter (documented future work).
3. CI/release workflows not executed on GitHub's runners.
4. `LICENSE` is empty while `package.json` references it — a public v1.0.0 tag
   is blocked on the owner choosing a license (see `FINAL_RELEASE_REPORT.md`).
5. Gemini bad-key → 400 (`INVALID_REQUEST`), and Ollama compat `finishReason` is
   `undefined` — documented behavioural nuances, not defects.

## Recommended v1.1 roadmap (not implemented — recorded only)

- Implement the native **Ollama chat provider (#16)** and a real
  **`PlaywrightBrowser`** backend.
- Add **streaming** to the chat providers (all buffer today).
- Consolidate the documented duplication clusters (`toError`, `messageOf`) once
  a shared home that respects the zero-dependency cores is justified.
- Wire the credential-gated live checks into a scheduled, secret-backed CI job.

## Bottom line

HermesOS is **production-ready in code**: deterministic, strongly typed,
comprehensively tested, security-hardened, and — now proven live — it builds and
runs as a container, serves its health/metrics endpoints, drives real git and a
real local LLM, persists and searches real vectors in Postgres/pgvector, and
classifies real cloud-API auth failures correctly. The remaining verifications
are gated on credentials and infrastructure, and the only release blocker is the
owner's license decision.

**READY WITH MINOR CAVEATS.**
