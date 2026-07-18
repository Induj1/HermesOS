# HermesOS Deployment & Operations (#41)

How to build, configure, run, and operate the HermesOS API service. Aimed at a
new operator going from a clone to a running, observable service.

## 1. Build and run

### Docker (the production path)

```bash
# Build the multi-stage image (compiles the workspace, ships only the API + its
# production dependencies via `pnpm deploy`):
docker build -t hermes-api .

# Run it — configuration comes entirely from the environment:
docker run --rm -p 3000:3000 -e PORT=3000 -e LOG_LEVEL=info hermes-api
```

Or via Compose (the `api` service is behind the opt-in `app` profile so it does
not affect native development):

```bash
docker compose --profile app up --build
```

### Local (development)

```bash
pnpm install
pnpm build
node apps/api/dist/main.js          # or: pnpm --filter @hermes/api start
```

The service logs a `listening` line and answers on `PORT` (default 3000).

## 2. Configuration reference

The API service reads these from the environment (declared in
`apps/api/src/config.ts` via `@hermes/config`; unset values fall back to the
default). See the source of truth — `describeSchema(apiSchema)` — for the live
list.

| Variable       | Type                             | Default      | Meaning                        |
| -------------- | -------------------------------- | ------------ | ------------------------------ |
| `PORT`         | port (1–65535)                   | `3000`       | TCP port to listen on          |
| `LOG_LEVEL`    | `debug`\|`info`\|`warn`\|`error` | `info`       | Minimum log level emitted      |
| `SERVICE_NAME` | string                           | `hermes-api` | Name stamped on every log line |

Invalid configuration fails fast at startup with a `ConfigError` that lists
**every** problem at once (a bad port and a bad level are reported together),
not one restart per typo.

### Secrets

Secrets are **never** baked into the image and should not be passed as plain
environment variables in production. Use the Docker/Compose `NAME_FILE`
convention or a mounted secret file, which `@hermes/secrets` reads:

```bash
# e.g. a database URL from a mounted file rather than the environment:
-e DATABASE_URL_FILE=/run/secrets/database_url
```

## 3. Operations runbook

### Health endpoints

| Endpoint      | Question                        | Orchestrator action on failure    |
| ------------- | ------------------------------- | --------------------------------- |
| `GET /livez`  | Is the process wedged?          | Restart the container (503)       |
| `GET /readyz` | Can it serve traffic right now? | Pull from the load balancer (503) |
| `GET /`       | Identity (name + version)       | —                                 |

Wire `/livez` to the container/orchestrator liveness probe and `/readyz` to the
readiness probe — **do not** cross-wire them: a readiness probe on liveness
turns a transient dependency blip into a crash-loop. The Docker image's
`HEALTHCHECK` already hits `/livez`.

### Metrics

`GET /metrics` returns Prometheus text exposition:

- `http_requests_total{method,status}` — request counts (rate = throughput).
- `http_request_duration_ms_bucket{method,le}` (+ `_sum`, `_count`) — latency
  distribution; compute p50/p90/p99 in the scraper.

Point a Prometheus scrape at `/metrics`. Every request is also logged as one
JSON line (structured, with `requestId`, `method`, `path`, `status`,
`durationMs`), so logs and metrics agree.

### Logs

JSON lines to stdout (`debug`/`info`) and stderr (`warn`/`error`) — ingest with
any aggregator. Secrets in log fields render as `[redacted]`. Trace correlation:
bind a request logger with `withTrace(logger, spanContext)` so each line carries
the `traceId`/`spanId`.

### Graceful shutdown

On `SIGTERM` (orchestrator stop) or `SIGINT` (Ctrl-C) the service stops
accepting connections, drains in-flight requests, and exits 0. Give it a
`stop_grace_period` (Compose sets 30s).

## 4. Credential list (for live verification)

Every credential-gated subsystem runs fully against a fake; these are what each
needs to run **live**. Supply a `FetchHttpClient` (and the credential) at the
composition root.

| Subsystem                        | Credential / infrastructure               | Confirms                                |
| -------------------------------- | ----------------------------------------- | --------------------------------------- |
| OpenAI (`provider-openai`)       | `OPENAI_API_KEY`                          | chat/embedding round-trip, error bodies |
| Anthropic (`provider-anthropic`) | `ANTHROPIC_API_KEY`                       | Messages API round-trip                 |
| Gemini (`provider-google`)       | `GEMINI_API_KEY`                          | `generateContent` round-trip            |
| Ollama (`provider-ollama`)       | a local Ollama server                     | local model round-trip                  |
| Git remote (`tools-git`)         | SSH key / token / helper                  | authenticated `push`/`pull`             |
| GitHub (`tools-github`)          | PAT, or App ID + RSA key + webhook secret | REST/GraphQL, App JWT, signed webhook   |
| Browser (`tools-browser`)        | a Chromium/Playwright runtime             | real DOM/JS behaviour                   |
| Telegram (`telegram`)            | a bot token (+ webhook secret)            | Bot API round-trip, signed webhook      |
| Memory (`memory`)                | a Postgres (pgvector) instance            | real vector storage/query               |

## 5. Verification status (infra-gated)

The image (#36), the CI/CD workflows (#37), and the security-audit `pnpm audit`
step (#38) are **authored and correct** but not executed in the build sandbox
(no Docker daemon, no CI runner). To confirm:

- `docker build -t hermes-api .` and run the container; assert `/livez` → 200.
- Open a PR; confirm the `Lint`/`Typecheck`/`Build`/`Test` jobs run the same
  gate that passes locally.
- Push a `v*` tag; confirm the `Release` workflow builds and pushes the image.
