# HermesOS Live Verification Checklist

Every integration below is **code-complete and verified against a deterministic
fake** in the test suite. What remains is _live_ confirmation against the real
service, which needs a credential or external runtime the build environment does
not have. None are code gaps.

For each integration: the required credential, how to verify, the expected
result, and the failure symptoms to watch for.

---

## 1. OpenAI provider (`@hermes/provider-openai`)

- **Credential:** `OPENAI_API_KEY` (or an OpenAI-compatible endpoint via
  `baseUrl`).
- **Verify:** construct `OpenAIClient` with a `FetchHttpClient`, call a chat
  completion and an embedding through the real API.
- **Expected:** a `ModelResponse` with content/usage; embeddings stored through
  `EmbeddingService` → `MemoryService`.
- **Failure symptoms:** `401` → `ModelError('auth')`; `429` → retryable
  rate-limit with `retry-after`; a wire-shape mismatch surfaces as a parse
  error. Rollback: none needed (read-only calls); revoke the key if leaked.

## 2. Anthropic provider (`@hermes/provider-anthropic`)

- **Credential:** `ANTHROPIC_API_KEY`.
- **Verify:** a chat/tool-calling round-trip over the Messages API
  (system-hoist, content-block, `tool_choice`).
- **Expected:** a `ModelResponse`; a multi-tool exchange round-trips.
- **Failure symptoms:** `401` auth error; `529` overloaded → retryable. No
  embeddings API. Rollback: none.

## 3. Gemini provider (`@hermes/provider-google`)

- **Credential:** `GEMINI_API_KEY`.
- **Verify:** a `generateContent` round-trip (user/model + `systemInstruction`
  bridge, `functionCallingConfig`).
- **Expected:** parsed candidate content; `MAX_TOKENS` → `length`,
  `SAFETY`/`RECITATION` → filtered.
- **Failure symptoms:** context-length override → `ContextTooLong`. Rollback:
  none.

## 4. Ollama (native provider #16 — deferred)

- **Runtime:** a local Ollama server (`brew install ollama`, `ollama serve`)
  with a pulled model (`ollama pull llama3.2`).
- **Status:** the **dedicated native provider (#16) is not built** and is marked
  🔜 in ROADMAP. Ollama is usable **today** via `@hermes/provider-openai`
  pointed at Ollama's OpenAI-compatible `/v1` endpoint (`baseUrl`).
- **Verify (via OpenAI-compat):** point `OpenAIClient` `baseUrl` at
  `http://127.0.0.1:11434/v1` and run a chat completion.
- **Expected:** a local model completion, no API key needed.
- **Failure symptoms:** connection refused → server not running
  (`just services-check`).

## 5. Git remote (`@hermes/tools-git`)

- **Credential:** an SSH key, a token, or a configured credential helper.
- **Verify:** `push`/`pull` against a real credentialed remote; the local
  lifecycle is already covered by `integration.test.ts` against real git.
- **Expected:** a successful transfer; a rejected push returns a structured
  `REJECTED` outcome. Clone URLs using remote-helper transports (`ext::…`) are
  refused with `UNSAFE_URL`.
- **Failure symptoms:** `AUTH_FAILED` (bad credential), `REMOTE_ERROR`
  (unreachable). Rollback: `git reset`/`git remote` locally.

## 6. GitHub (`@hermes/tools-github`)

- **Credentials:** (1) a personal access token; (2) a GitHub App ID + RSA
  private key; (3) a webhook secret.
- **Verify:** a REST/GraphQL round-trip with the PAT; the App JWT →
  installation-token exchange; a real signed webhook delivery.
- **Expected:** paginated results; a valid installation token; a webhook whose
  HMAC signature verifies (`crypto.timingSafeEqual`).
- **Failure symptoms:** `401`/`403` on a bad token; signature mismatch → the
  webhook is rejected before its body is parsed. Rollback: revoke token/App key.

## 7. Playwright / browser (`@hermes/tools-browser`)

- **Runtime:** a Chromium/Playwright install
  (`npx playwright install chromium`).
- **Verify:** implement a `PlaywrightBrowser` over the existing port and run the
  browser tool suite against it (the `FakeBrowser` approximates DOM/JS today).
- **Expected:** real CSS visibility, live DOM mutation, real dialogs/downloads.
- **Failure symptoms:** launch failure → missing browser binary. Rollback: none
  (headless, ephemeral).

## 8. Telegram (`@hermes/telegram`)

- **Credentials:** a bot token from @BotFather; optionally a webhook secret.
- **Verify:** `getMe`/`sendMessage`/`getUpdates` against `api.telegram.org` with
  a `FetchHttpClient`; a real signed webhook delivery.
- **Expected:** the bot's identity; a sent message appears in the chat; the
  update offset acknowledges. Error messages never contain the token-bearing
  URL.
- **Failure symptoms:** `401 Unauthorized` on a bad token; a forged webhook is
  rejected by the constant-time secret-token check. Rollback: revoke the token
  in @BotFather.

## 9. Postgres / pgvector (`@hermes/memory`)

- **Infrastructure:** a Postgres 17 instance (native via `brew`, or the
  `containerized` compose profile), with the extensions from
  `infrastructure/postgres/init/`. `just db-init` provisions it.
- **Verify:** run the `tests/` integration suite (needs `just services-check` to
  pass); store and query real vectors end to end.
- **Expected:** conversation/record/mission persistence; pgvector similarity
  queries return ranked results.
- **Failure symptoms:** connection refused → service down; missing extension →
  re-run `just db-init`. Rollback: `just postgres-dump` before changes;
  transactions roll back on error.

## 10. Docker image (#36)

- **Infrastructure:** a Docker daemon (>= 24).
- **Verify:**
  ```bash
  docker build -t hermes-api .
  docker run --rm -p 3000:3000 -e PORT=3000 hermes-api
  curl -f http://127.0.0.1:3000/livez        # expect 200
  ```
  Or `docker compose --profile app up --build`.
- **Expected:** the image builds via `pnpm deploy` (no source, no devDeps, runs
  as `node`), the container's `HEALTHCHECK` reports healthy, `/livez`/`/readyz`/
  `/metrics` answer.
- **Failure symptoms:** a `pnpm deploy` resolution error → a workspace dep was
  not built first (the build stage runs `pnpm build`); an unhealthy container →
  `/livez` not answering. Rollback: `docker compose --profile app down`.

## 11. CI/CD (#37)

- **Infrastructure:** GitHub Actions (a hosted runner) and, for the image push,
  the ambient `GITHUB_TOKEN` (GHCR).
- **Verify:** open a PR — the **Lint / Typecheck / Build / Test** jobs run the
  same gate that passes locally (`test:coverage`, so per-package ≥95% coverage
  gates the merge). Push a `v*` tag — the **Release** workflow builds and pushes
  the image to GHCR.
- **Expected:** all four PR jobs green; the release job publishes
  `ghcr.io/<repo>/api:<version>`.
- **Failure symptoms:** a coverage regression fails the Test job; a bad emit
  fails Build; a push without `packages: write` permission fails the release.
  Rollback: the image is versioned by tag; re-tag to re-release.

---

## Summary

| #   | Integration       | Needs                                                                  |          Fake-verified           |
| --- | ----------------- | ---------------------------------------------------------------------- | :------------------------------: |
| 1   | OpenAI            | `OPENAI_API_KEY`                                                       |                ✅                |
| 2   | Anthropic         | `ANTHROPIC_API_KEY`                                                    |                ✅                |
| 3   | Gemini            | `GEMINI_API_KEY`                                                       |                ✅                |
| 4   | Ollama            | local server (native provider #16 deferred; OpenAI-compat works today) |      ✅ (via OpenAI-compat)      |
| 5   | Git remote        | SSH key / token                                                        | ✅ (+ real-git integration test) |
| 6   | GitHub            | PAT, App key, webhook secret                                           |                ✅                |
| 7   | Playwright        | Chromium runtime                                                       |         ✅ (FakeBrowser)         |
| 8   | Telegram          | bot token, webhook secret                                              |                ✅                |
| 9   | Postgres/pgvector | a Postgres 17 instance                                                 |     ✅ (+ integration tests)     |
| 10  | Docker            | a Docker daemon                                                        |     authored, build not run      |
| 11  | CI/CD             | a hosted runner                                                        |        authored, not run         |
