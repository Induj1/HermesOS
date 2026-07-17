# HermesOS Status

A running account of what is built, what is verified, and what is blocked.
Updated after each subsystem. For the ordered plan, see ROADMAP.md.

## At a glance

- **12 subsystems complete**, each with an RFC, a README, and enforced ≥95% test
  coverage.
- **1600 tests** pass repo-wide. Lint, typecheck, build, and format are clean.
- **Nothing is blocked yet.** GitHub Integration (#12) is next and is the first
  credential-gated item; its client and contract tests will ship against a fake
  GitHub server, with only the live round-trip left to confirm.

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
| Git Tools        | `@hermes/tools-git`   | 106   | Shell-executor reuse; structured porcelain reads; 3-grade perms.  |

## Simulated / awaiting live verification

- **Git remote operations** (`@hermes/tools-git`) — `clone`, `fetch`, `pull`,
  and `push` are implemented and unit-tested against `FakeGitExecutor` (argv and
  result-shaping, including a rejected-push report). The full local lifecycle is
  verified against **real git** in `integration.test.ts`. What is _not_ covered:
  a live round-trip to an authenticated remote, which needs a credential (an SSH
  key, a token, or a credential helper) the build does not have. **To confirm
  live:** point `push`/`pull` at a real credentialed remote and assert the
  transfer. See RFC-0010 §10.

The remaining rows fill in as credential-gated subsystems are built: each lists
what is implemented, what is exercised against a fake, the exact credential
required, and what remains to confirm live.

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
- **Git failure classification is best-effort** (RFC-0010 §6) — it keys on git's
  human-facing message strings; the exit code and raw output are always carried
  so a caller need not trust the derived code.

## Verification

Every commit passes
`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm format`.
Coverage thresholds (95% lines/branches/functions/statements) are enforced per
package in `vitest.config.ts`, so a drop fails CI rather than being noticed
later.
