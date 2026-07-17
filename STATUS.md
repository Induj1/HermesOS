# HermesOS Status

A running account of what is built, what is verified, and what is blocked.
Updated after each subsystem. For the ordered plan, see ROADMAP.md.

## At a glance

- **11 subsystems complete**, each with an RFC, a README, and enforced ≥95% test
  coverage.
- **1494 tests** pass repo-wide. Lint, typecheck, build, and format are clean.
- **Nothing is blocked yet.** The first credential-gated item (GitHub, #12) is
  one subsystem away, and even it will ship its client and tests against a fake
  before stopping.

## Complete

| Subsystem        | Package               | Tests | Notes                                                             |
| ---------------- | --------------------- | ----- | ----------------------------------------------------------------- |
| Kernel           | `@hermes/kernel`      | 161   | Zero-dependency runtime: missions, tasks, scheduler, event bus.   |
| Memory           | `@hermes/memory`      | 304   | Postgres-backed; pgvector-ready; conversation/record/mission.     |
| Planner          | `@hermes/planner`     | 201   | Goal → validated plan → `MissionSpec`. Strategy chain, replanner. |
| Execution Engine | `@hermes/execution`   | 197   | Runs plans; `$from` data flow; checkpoints; pause/resume.         |
| Agent Framework  | `@hermes/agent`       | 172   | Decide-never-execute; reasoners; sessions; delegation.            |
| Model Contracts  | `@hermes/model`       | 42    | Provider interfaces; zero dependencies.                           |
| Tool Framework   | `@hermes/tools`       | 175   | Self-describing tools; schemas; permissions; discovery.           |
| Filesystem Tools | `@hermes/tools-fs`    | 104   | Rooted, cancellable; port + Node + memory implementations.        |
| Shell Tools      | `@hermes/tools-shell` | 46    | Argv-not-shell; allowlist; timeout/output caps; env isolation.    |
| HTTP Tools       | `@hermes/tools-http`  | 92    | SSRF policy (pure); redirect re-checking; streaming size cap.     |

## Simulated / awaiting live verification

Nothing yet. This section fills in as credential-gated subsystems are built:
each will list what is implemented, what is exercised against a fake, the exact
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

## Verification

Every commit passes
`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm format`.
Coverage thresholds (95% lines/branches/functions/statements) are enforced per
package in `vitest.config.ts`, so a drop fails CI rather than being noticed
later.
