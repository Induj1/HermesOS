# @hermes/api

The HermesOS HTTP API service — the composition root that wires the platform
together (config, structured logging, health, metrics, REST) into a runnable,
observable server.

- **Design record:** [RFC-0036](../../docs/rfcs/RFC-0036-production.md).
- **Deployment & operations:**
  [docs/deployment](../../docs/deployment/README.md).

## Run

```bash
pnpm --filter @hermes/api build
PORT=3000 node apps/api/dist/main.js     # or: pnpm --filter @hermes/api start
```

Or in Docker (from the repo root):

```bash
docker build -t hermes-api . && docker run --rm -p 3000:3000 hermes-api
```

## Endpoints

| Endpoint       | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `GET /`        | Service identity (name + version)                   |
| `GET /livez`   | Liveness — is the process wedged? `200`/`503`       |
| `GET /readyz`  | Readiness — are dependencies reachable? `200`/`503` |
| `GET /metrics` | Prometheus exposition of request counters/latency   |

## Configuration

Read from the environment via `@hermes/config` (unset → default):

| Variable       | Default      | Meaning                                              |
| -------------- | ------------ | ---------------------------------------------------- |
| `PORT`         | `3000`       | TCP port                                             |
| `HOST`         | `0.0.0.0`    | Interface to bind; `127.0.0.1` restricts to loopback |
| `LOG_LEVEL`    | `info`       | `debug`\|`info`\|`warn`\|`error`                     |
| `SERVICE_NAME` | `hermes-api` | Name on every log line                               |

## Design

`buildApp(deps)` is a **pure function** returning a REST `Application` — it
takes its logger, health monitor, metrics registry, and clock as arguments, so
the whole routing and observability surface is tested with `app.handle(request)`
and no socket. An observability middleware counts, times, and logs every request
(including errors). `main.ts` (the `hermes-api` bin) is the only impure module:
it loads config, constructs the real dependencies, binds the socket, and handles
`SIGTERM`/`SIGINT` graceful shutdown.
