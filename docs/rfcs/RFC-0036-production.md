# RFC-0036: Production Tier (API service, Docker, CI/CD, audit, docs)

| Field      | Value                                                     |
| ---------- | --------------------------------------------------------- |
| Status     | Implemented (🔧 build/CI steps are infra-gated)           |
| Date       | 2026-07-18                                                |
| Scope      | `apps/api`, `Dockerfile`, `.github/workflows`, `docs/*`   |
| Depends on | The platform tier (config, logger, health, metrics, rest) |
| Milestones | Production #36, #37, #38, #40, #41                        |

Design record for the Production tier: the API composition root and the
deployment, CI, audit, performance, and documentation milestones. (#39 Load
Testing has its own RFC-0035.)

---

## 1. The API composition root (`apps/api`)

Docker (#36) needs something real to run, and the platform tier needs a place
where its pieces are wired together. `apps/api` is that composition root, and it
is deliberately split so the logic is testable and the impurity is isolated:

- **`buildApp(deps)`** is a **pure function** returning a REST `Application`
  wired with the operational endpoints every production service needs — `GET /`
  (identity), `GET /livez` (liveness → 200/503), `GET /readyz` (readiness →
  200/503), `GET /metrics` (Prometheus). It takes its logger, health monitor,
  metrics registry, and clock as arguments, so the whole routing and
  observability surface is tested with `app.handle(request)` — no socket. 100%
  coverage.
- An **observability middleware** counts every request
  (`http_requests_total{method,status}`), times it into a histogram, and logs it
  once. It **counts errors too**: the REST error boundary sits outside the
  middleware chain, so the middleware catches, records the resolved status
  (`errorStatus` — an `HttpError`'s status, else 500), and re-throws for the
  boundary to format. Without that, every 4xx/5xx would go uncounted.
- **`main()`** (in `main.ts`, the `hermes-api` bin) is the only impure module:
  it loads config from the environment, constructs the real dependencies, binds
  a socket via `toNodeListener`, and installs `SIGTERM`/`SIGINT` graceful
  shutdown. It is excluded from unit coverage because it _is_ the I/O — it is
  exercised by running the service.

This is the first place the platform tier composes end to end, and it validates
the injection discipline: every subsystem took its clock/transport/sink as a
parameter, so wiring them is a handful of `new`s with nothing to mock.

## 2. Docker (#36)

A two-stage `Dockerfile`: `build` compiles the whole workspace, then
`pnpm --filter @hermes/api deploy --prod /prod/api` isolates just the API and
its **production** dependencies; `runtime` carries only that. The result ships
no source, no devDependencies, and no other package's tests. Configuration is
read from the environment at runtime — **nothing is baked in**, no secrets in a
layer. The container runs as the unprivileged `node` user and declares a
`HEALTHCHECK` that hits `/livez` with Node's global `fetch` (the slim image has
no curl). The `api` service is added to `docker-compose.yml` behind an opt-in
`app` profile so native development is untouched.

## 3. CI/CD (#37)

`ci.yml` runs the exact local gate on every PR and push to `main`, as parallel
jobs so a failure names which check broke: **Lint** (ESLint + Prettier),
**Typecheck**, **Build** (dist is what the image ships — a package can
type-check yet fail to emit), and **Test** (`test:coverage`, so each package's
≥95% branch threshold gates the merge, not just green tests). `release.yml`
builds and pushes the image to GHCR on a `v*` tag, tagged by semver via
`docker/metadata-action`.

## 4. Security audit (#38)

`docs/security/audit.md` enumerates the thirteen trust boundaries, the control
at each (SSRF policy, argv-not-shell, path rooting, permission grades, webhook
signatures, constant-time auth, deny-override authz, secret redaction, non-root
container), and the residual risk, plus the `pnpm audit` action. It is a
standing document to re-read as subsystems change, not a one-time gate.

## 5. Performance (#40)

`docs/architecture/performance.md` records the **method** (instrument with a
metrics histogram → baseline with `@hermes/loadtest` → change one thing →
re-measure → guard tests/coverage) and the candidate hot paths, and is honest
that recorded percentile numbers require a real run environment the sandbox
lacks. It does not fabricate benchmark figures; the instrumentation to produce
them ships and is tested.

## 6. Production documentation (#41)

`docs/deployment/README.md` is the operator's guide: build/run (Docker, Compose,
local), the configuration reference, the operations runbook (health endpoints
and their probe wiring, metrics, logs, graceful shutdown), and the consolidated
credential list for every gated subsystem.

## 7. What is infra-gated (🔧)

Three steps are authored and correct but cannot be _executed_ in the build
sandbox, and are documented as such: the `docker build`/run (no Docker daemon),
the CI workflow runs (no hosted runner), and the `pnpm audit` result (run in
CI). None are code gaps — they need infrastructure, exactly as the
credential-gated subsystems need a key.

## 8. Testing

`apps/api` has 12 tests at 100% branch coverage: `errorStatus` (both branches),
each endpoint (`/`, `/livez` 200, `/readyz` 503 and the no-readiness-checks
case, `/metrics`), the observability middleware (counting success and a 404,
logging, clock-measured duration), and the config schema (defaults, overrides,
invalid port, version). Combined with `@hermes/loadtest` (#39, RFC-0035), the
Production tier's _code_ is fully covered; its _artifacts_ (image, workflows)
are verified by running them.
