# Production Tier (#36–41)

The Production tier turns the built subsystems into something deployable and
operable. Unlike the earlier tiers, most of these milestones are **not npm
packages** — they are build artifacts, CI configuration, audits, and
documentation. This file defines each one explicitly so the scope is fixed
before implementation begins: no invented functionality, each milestone cohesive
and aligned with the existing architecture.

Legend for "Package": `—` means the milestone ships repo-level files (a
Dockerfile, a workflow, a document), not a workspace package.

| #   | Milestone                | Package            | Kind              |
| --- | ------------------------ | ------------------ | ----------------- |
| 36  | Docker Production        | —                  | Build artifact    |
| 37  | CI/CD                    | —                  | CI configuration  |
| 38  | Security Audit           | —                  | Document + gate   |
| 39  | Load Testing             | `@hermes/loadtest` | Package (harness) |
| 40  | Performance Optimization | —                  | Changes + report  |
| 41  | Production Documentation | —                  | Documentation     |

---

## #36 — Docker Production

- **Package:** — (repo-level `Dockerfile`, `.dockerignore`,
  `docker-compose.yml`)
- **Responsibilities:** A reproducible multi-stage image that builds the pnpm
  workspace once and runs a selected service entry point (the REST API or the
  worker). A Compose stack that brings up a service alongside its Postgres
  dependency for a local production-like run. Configuration comes entirely from
  the environment (via `@hermes/config`), never baked into the image.
- **Dependencies:** service entry points (REST #24, Worker #22), Configuration
  (#30), Secrets (#31). No new application code.
- **Completion criteria:** the image builds from a clean checkout; a container
  starts the chosen service and answers its health endpoint (#35);
  `docker compose up` brings the service and Postgres up together; the build
  carries no secrets and is documented in the deployment guide (#41).

## #37 — CI/CD

- **Package:** — (`.github/workflows/*.yml`)
- **Responsibilities:** On every pull request and push, run the exact gate every
  commit already runs locally — `lint`, `typecheck`, `build`, `test` (with the
  per-package ≥95% coverage thresholds), and a `format` check — across the whole
  workspace on a hosted runner. On a version tag, build the Docker image (#36).
- **Dependencies:** the established package scripts and coverage thresholds; the
  Dockerfile (#36) for the image job.
- **Completion criteria:** a workflow that runs the full gate suite green in CI
  and fails the build on any lint, type, coverage, or format regression; the
  image job builds on a tag.

## #38 — Security Audit

- **Package:** — (`docs/security/audit.md`, plus `pnpm audit` wired into CI)
- **Responsibilities:** Enumerate the trust boundaries and abuse surfaces the
  system already defends — SSRF policy (`@hermes/tools-http`), argv-not-shell
  execution (`@hermes/tools-shell`), path rooting (`@hermes/tools-fs`),
  permission grades (`@hermes/tools`), webhook signature verification
  (`@hermes/tools-github`), and secret redaction (#31) — and document the
  control at each and its residual risk. Run a dependency vulnerability audit.
  This milestone reviews and records; it does not add features.
- **Dependencies:** all subsystems; Authorization (#27), Secrets (#31).
- **Completion criteria:** an audit document mapping each surface → control →
  residual risk, with a clean or explicitly triaged `pnpm audit`, wired to run
  in CI (#37).

## #39 — Load Testing

- **Package:** `@hermes/loadtest`
- **Responsibilities:** A deterministic in-process load harness that drives the
  REST `Application` and the `Worker` through their existing ports (no real
  network, no real clock) at a configurable concurrency and request count, and
  measures throughput, latency distribution, and queue-drain time using the
  histograms already built in `@hermes/metrics`. Scenarios are data; the harness
  is a pure function of (scenario, injected clock) so a run is reproducible.
- **Dependencies:** REST (#24), Worker (#22), Metrics (#33), kernel `Clock`.
- **Completion criteria:** the harness runs a scenario and produces a
  latency/throughput report; baseline numbers are recorded; the harness logic
  itself meets the ≥95% coverage bar with deterministic tests.

## #40 — Performance Optimization

- **Package:** — (targeted changes across existing packages +
  `docs/architecture/performance.md`)
- **Responsibilities:** Use the load harness (#39) and the metrics to locate hot
  paths (context packing, router selection, queue claim, provider request
  shaping), apply safe and measured optimizations, and record before/after. No
  behaviour changes — only cost changes — and every existing test and coverage
  threshold must still hold.
- **Dependencies:** Load Testing (#39), Metrics (#33).
- **Completion criteria:** documented optimizations, each with a measured
  improvement from the harness and no test or coverage regression.

## #41 — Production Documentation

- **Package:** — (`docs/deployment/*`)
- **Responsibilities:** A deployment guide (how to build and run the image and
  Compose stack), a configuration reference generated from `@hermes/config`'s
  declared schema, an operations runbook (the health, metrics, and tracing
  endpoints and how to read them), and a single consolidated list of the
  credentials each subsystem needs to run live.
- **Dependencies:** Configuration (#30), Secrets (#31), Docker (#36),
  Observability (#32/#34/#35).
- **Completion criteria:** a coherent deployment + operations document set that
  a new operator can follow from clone to running system, with the credential
  list matching the per-subsystem notes in STATUS.md.
