# Contributing to HermesOS

Thanks for taking the time to contribute. This document covers how to get the
project running, the conventions we hold to, and what happens to your pull
request once you open it.

By participating you agree to uphold our [Code of Conduct](#code-of-conduct),
and to license your contributions under the terms in [LICENSE](./LICENSE).

## Table of contents

- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Working with the infrastructure](#working-with-the-infrastructure)
- [Commit conventions](#commit-conventions)
- [Pull requests](#pull-requests)
- [Testing](#testing)
- [Proposing significant changes](#proposing-significant-changes)
- [Reporting bugs](#reporting-bugs)
- [Security issues](#security-issues)
- [Code of conduct](#code-of-conduct)

## Getting started

### Prerequisites

| Tool       | Version | Notes                                                        |
| ---------- | ------- | ------------------------------------------------------------ |
| Node.js    | >= 22   | Use the version in `.nvmrc` if present                       |
| pnpm       | >= 9.5  | `corepack enable && corepack prepare pnpm@latest --activate` |
| just       | >= 1.30 | `brew install just`, or see the [just README][just]          |
| PostgreSQL | 17      | `brew install postgresql@17`                                 |
| Redis      | >= 7    | `brew install redis`                                         |
| Ollama     | current | `brew install ollama`                                        |
| Docker     | >= 24   | **Optional** — only for the `containerized` compose profile  |

[just]: https://github.com/casey/just#installation

The backing services run natively, not in containers — see
[Working with the infrastructure](#working-with-the-infrastructure) for why.
Start them once and launchd keeps them running across reboots:

```bash
brew services start postgresql@17
brew services start redis
brew services start ollama
```

### Bootstrap

```bash
git clone https://github.com/<org>/HermesOS.git
cd HermesOS
just setup
```

`just setup` verifies your toolchain, writes a `.env` with freshly generated
credentials, installs dependencies, provisions the database (`just db-init`),
and pulls the Ollama models named in `OLLAMA_MODELS`. Expect the first model
pull to take several minutes.

Then:

```bash
just dev
```

Run `just` at any time to list every available recipe. If setup fails,
`just doctor` reports exactly which tool is missing or too old, and
`just services-check` reports which service is not answering.

## Development workflow

1. **Open an issue first** for anything beyond a small fix. It is cheaper to
   align on approach before the code exists than during review.
2. **Branch from `main`.** Name it `<type>/<short-description>`, e.g.
   `feat/kernel-scheduler` or `fix/redis-reconnect`.
3. **Make your change**, with tests.
4. **Run `just check`** — a superset of CI: everything CI gates on (lint,
   formatting, typecheck) plus the build and tests.
5. **Open a pull request** against `main`.

Everyday recipes:

```bash
just dev             # check services, then app dev servers
just test            # full test suite
just test kernel     # filter to one package
just lint            # ESLint
just typecheck       # tsc, no emit
just fmt             # apply formatting and lint autofixes
just fmt-check       # verify formatting without rewriting (what CI checks)
just check           # lint, format, typecheck, build, test — run before pushing
just clean           # drop build output and caches
```

## Working with the infrastructure

Everything runs on the host: PostgreSQL, Redis, and Ollama as Homebrew services,
application code under `pnpm`. Nothing is containerized by default.

The deciding factor is Ollama. Docker Desktop does not pass Metal through, so a
containerized Ollama on macOS runs inference on the CPU and is slow enough to
change how you work. Once Ollama has to be native, running Postgres and Redis in
Docker only buys a split mental model — two ways to start things, two places to
look for logs — so they are native too. macOS is what the team develops on;
Linux and CI still get a reproducible target from the `containerized` profile
below.

```bash
just services-check     # are postgres, redis, and ollama answering?
just db-init            # provision the hermes role, database, and extensions

just postgres                       # psql shell
just postgres -c 'select version()' # one-off query
just postgres-dump before-migration # dump to ./backups/

just redis              # redis-cli
just redis dbsize       # one-off command

just ollama             # list installed models
just ollama pull llama3.2
```

If a service is down, `just services-check` names it and gives you the
`brew services start ...` line to fix it. `just dev` runs this check first, so
you get a one-line diagnosis instead of a connection error from deep inside the
app.

`just db-init` is the native counterpart to what the Postgres container used to
do on first boot: it creates the `hermes` role and database using the password
in your `.env`, then applies `infrastructure/postgres/init/`. It is idempotent —
run it whenever you rotate `POSTGRES_PASSWORD` or drop the database.

`just redis-flush` destroys data and will prompt for confirmation. Read the
target it prints first: unlike a container, your Homebrew Redis is shared with
every other project on your machine, and `flushall` does not respect that.

### The `containerized` profile

The Docker definitions are still in `docker-compose.yml`, behind an opt-in
profile. Use them to reproduce a Linux/CI failure, or to check a change against
the same images production runs.

```bash
just docker-up          # postgres + redis + ollama in Docker
just docker-up gpu      # NVIDIA-backed Ollama
just docker-down        # stop; volumes are preserved
just docker-logs redis  # tail one service
just docker-ps          # status and health
just docker-reset       # DESTROYS the Docker volumes; prompts first
```

Two things to know before you opt in:

- **Ports collide.** The containers bind 5432 / 6379 / 11434, which your
  Homebrew services already hold. Stop the brew service first
  (`brew services stop postgresql@17`) or override `POSTGRES_PORT` /
  `REDIS_PORT` / `OLLAMA_PORT` in `.env`.
- **Redis needs a password.** `REDIS_PASSWORD` is empty for native development
  because a stock Homebrew Redis has no `requirepass`, and setting one would
  affect every other project on your machine. The profile refuses to start
  without it — set `REDIS_PASSWORD` and add it back to `REDIS_URL` as
  `redis://default:<password>@127.0.0.1:6379`. Name the `default` user
  explicitly: `redis-cli` 8 reads the empty username in the shorter
  `redis://:<password>@` form literally, sends `AUTH "" <password>`, and gets
  back `WRONGPASS`.

`just docker-reset` only removes Docker volumes; your native data is untouched.

The service recipes (`just postgres`, `just redis`, `just ollama`) drive the
host CLIs against the URLs in `.env`, so they work against either the native
services or the containers — whichever currently owns the port.

### Configuration

All configuration lives in `.env`, which is git-ignored. **When you add a new
environment variable, add it to `.env.example` in the same commit**, with a safe
placeholder and a comment explaining what it does. A reviewer should be able to
tell what a variable is for without reading the code that consumes it. Never
commit a real secret — not in `.env.example`, not in a test fixture, not in a
comment.

Variables in `.env.example` are tagged `[both]` or `[containerized]` so you can
tell which ones matter for native development.

`infrastructure/postgres/init/` is for cluster-level setup such as extensions.
It is applied by `just db-init`, and by the containerized Postgres on the first
boot of an empty volume. **Every statement must be idempotent** — `db-init`
re-runs the whole directory each time. **Schema changes belong in migrations,
not here.**

## Commit conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/). The
history is used to generate changelogs, so the prefix matters.

```
<type>(<optional scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`.

```
feat(kernel): add cooperative task scheduler
fix(redis): reconnect with backoff after connection drop
docs: document the Ollama GPU profile
```

Write the description in the imperative mood ("add", not "added"), lowercase,
with no trailing period. For a breaking change, append `!` after the type
(`feat(api)!: ...`) and explain the migration path in a `BREAKING CHANGE:`
footer.

Keep commits focused: one logical change each. A reviewer should be able to read
your commit list and understand the shape of the change before opening the diff.

## Pull requests

Before you open one:

- `just check` passes locally.
- New behavior has tests; fixed bugs have a regression test.
- Docs are updated in the same PR — README, `.env.example`, or the relevant file
  under `docs/`.
- The branch is rebased on current `main`.

In the description, explain **why** the change is needed, not just what it does.
Link the issue it closes. If it touches anything visible to users, include a
screenshot or a snippet of output.

Review expectations:

- At least one maintainer approval is required to merge.
- CI must be green.
- Address review comments with new commits rather than force-pushing mid-review,
  so reviewers can read the delta. Squashing happens at merge.
- PRs are merged with squash-and-merge; the PR title becomes the commit message,
  so it must follow the commit convention above.

Draft PRs are welcome for early feedback — mark them as drafts so reviewers know
they are not being asked for a final pass.

## Testing

- Unit tests live beside the code they test.
- Integration tests that need real services live in `tests/` and assume
  `just services-check` passes.
- Tests must not depend on each other's state or on execution order. Anything
  touching Postgres or Redis is responsible for cleaning up after itself.
- Never assert against a live model's exact output. Model responses are not
  deterministic — assert on shape, schema, or invariants instead, and stub the
  model at the boundary for unit tests.

## Proposing significant changes

Anything that changes an interface between components, adds a dependency, or is
hard to reverse should start as a written proposal rather than a PR.

- **RFCs** (`docs/rfcs/`) — for designs still being decided. Open one to gather
  feedback before you build.
- **ADRs** (`docs/adr/`) — for decisions already made. An ADR records the
  context, the decision, and the consequences so that a future contributor
  understands why the code looks the way it does.

Copy the numbering style of the existing files. If you are unsure which you
need, open an issue and ask.

## Reporting bugs

Open an issue including:

- What you expected and what actually happened.
- Minimal steps to reproduce.
- Your environment: OS, `node --version`, `pnpm --version`, and the output of
  `just services-check`. If it happens under the `containerized` profile, say so
  and include `docker --version`.
- Relevant service logs: `brew services info --json <service>` points at the log
  path; use `just docker-logs` for the containerized profile.

Redact credentials before pasting logs.

## Security issues

**Do not open a public issue for a security vulnerability.** See
[SECURITY.md](./SECURITY.md) if present, or email the maintainers privately. We
will acknowledge your report and coordinate a fix and disclosure timeline with
you.

## Code of conduct

Be respectful and constructive. Assume good faith, critique the code rather than
the person, and remember that a reviewer's time is a gift. Harassment of any
kind is not tolerated. Report concerns to the maintainers.
