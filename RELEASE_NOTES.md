# HermesOS v1.0.0

**A personal operating system for agents** — a production-grade, composable
runtime for autonomous AI, built as a TypeScript/pnpm monorepo.

This is the first public release. A zero-dependency **kernel** runs a graph of
tasks toward a goal; everything else — models, tools, memory, scheduling,
observability, and interfaces — plugs in as a composable subsystem. Every piece
is strongly typed, deterministic, tested to ≥95% branch coverage, and documented
by an RFC.

## Highlights

- **Six complete tiers** — foundations, tools, models, runtime & interfaces,
  platform, and production (40 of 41 roadmap items; the native Ollama provider
  is the one deferred item, and Ollama already works via the OpenAI-compatible
  endpoint).
- **Runnable service** — `@hermes/api` wires config, logging, health, metrics,
  and REST into a container that serves `/`, `/livez`, `/readyz`, and
  `/metrics`.
- **Deterministic by construction** — every external dependency is an injected
  interface with a fake, so no test touches a real network or wall clock.
- **Minimal surface** — one non-`@hermes/*` runtime dependency in the entire
  monorepo (`pg`).

## Verified live (this release)

Validated against real infrastructure:

- **Docker** — image builds (non-root, ~348 MB), runs, healthcheck healthy; the
  Compose `app` profile comes up healthy.
- **Postgres + pgvector** — 304 integration tests: migrations, embedding
  storage, and similarity search (brute-force and pgvector HNSW).
- **Ollama** — real local chat (OpenAI-compatible) and native embeddings.
- **git** — full clone / fetch / branch / merge / push against a real repo.
- **Cloud endpoints** — OpenAI, Anthropic, Gemini, GitHub, and Telegram reached
  live; invalid-credential handling confirmed (secrets never leak into errors).

See `PRODUCTION_CERTIFICATION.md` for the complete evidence and
`LIVE_VERIFICATION.md` for the credential-gated checklist.

## Security

SSRF protection re-checked on every redirect, argv-not-shell execution, path
rooting, constant-time credential/signature comparison, default-deny
authorization, and secret redaction by construction. `pnpm audit` is clean and
gated in CI. Details in `SECURITY_REVIEW.md`; disclosure policy in
`SECURITY.md`.

## Install

```bash
git clone https://github.com/<org>/HermesOS.git
cd HermesOS
pnpm install && pnpm build && pnpm test
```

Run the API:

```bash
docker build -t hermes-api . && docker run --rm -p 3000:3000 hermes-api
# or: pnpm --filter @hermes/api build && PORT=3000 node apps/api/dist/main.js
```

## Known limitations

- No dedicated native Ollama chat provider (#16) or real Playwright backend yet;
  chat providers buffer rather than stream. The credential-gated cloud
  integrations are verified against fakes and their live auth paths — full
  happy-path verification needs real API keys.

## License

MIT. See [LICENSE](LICENSE).

**Full changelog:** [CHANGELOG.md](CHANGELOG.md).
