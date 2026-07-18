# HermesOS — Final Release Report

Production-readiness verification performed as a release engineer. This report
summarizes every issue found, every fix made, and the v1.0.0 verdict.

## Verdict

**Release-candidate quality. Not yet v1.0.0-taggable** — blocked only on an
owner decision (the license) and steps that need infrastructure to execute. The
code, tests, security posture, and documentation are in strong shape.

The repository is fully green: **lint, typecheck, build, format, and per-package
≥95% coverage all pass — 2465 tests, 0 failures**, working tree clean. A
`pnpm audit` (production and full) reports **no known vulnerabilities**.

The version was **not** bumped to v1.0.0, per the "only if everything passes"
condition — see the blockers below.

## Audit method

Five parallel read-only audits (security, dependencies, dead-code/duplication,
documentation consistency) with concrete file:line evidence, plus a direct
fresh-install verification (install → build → test → lint → typecheck → run the
API). Fixes were applied only for genuine issues, in four focused commits, each
run through the full gate.

## Issues found and fixed

### Security (2 hardenings — both Low/defense-in-depth)

1. **git clone remote-helper RCE vector.** `git.clone` passed the URL to git
   unchecked; git's `<transport>::<address>` URLs (`ext::sh -c '…'`) execute a
   command. Added `assertCloneUrlSafe` — the tool now rejects that form (and an
   empty URL) with `UNSAFE_URL` before invoking git. Normal
   https/git/ssh/file/scp URLs pass. (`fix(security)`, 3 tests added)
2. **API bound `0.0.0.0` with no override.** Added a `HOST` config var (default
   `0.0.0.0` for containers; `127.0.0.1` restricts to loopback on bare metal).

The security audit otherwise found **no High or Medium issues**: argv-not-shell
execution, path rooting (no TOCTOU), SSRF policy re-checked on every redirect,
constant-time credential/signature comparison, crypto randomness, and
default-deny authorization are all correctly hardened. Full detail in
[SECURITY_REVIEW.md](SECURITY_REVIEW.md).

### Dependencies (4 unused removed)

`@hermes/context`, `@hermes/provider-anthropic`, `@hermes/provider-openai` each
declared `@hermes/kernel` but never imported it; `services/execution` declared
`@hermes/memory` (referenced only in comments). Removed — coupling reduced,
manifests honest. (`chore(deps)`)

### Documentation accuracy (corrected)

- **STATUS.md over-claimed "all 41 items complete."** The dedicated
  Ollama-native provider (#16) is genuinely unbuilt (🔜 in ROADMAP); Ollama
  works today via the OpenAI-compatible provider. Corrected to "40 of 41 built."
- Fixed the test count (2462→2465), the unit count (→33 packages + 2 apps + 4
  services), "four providers"→three, and the stale CONTRIBUTING "superset of CI"
  claim (CI now runs the full gate). Expanded the tracked-duplication note.
- **Empty root README.md** (the front door) — written. Added missing READMEs for
  `@hermes/api`, `@hermes/kernel`, `@hermes/memory` (STATUS claimed all
  subsystems had one).
- **Broken `SECURITY.md` link** in CONTRIBUTING — added SECURITY.md.
- **`.env.example` missing `PORT`/`HOST`/`SERVICE_NAME`** (the API service's
  config, required by the repo's own convention) — added.

### CI hardening

Added a `pnpm audit --prod` job so a future vulnerability in a production
dependency fails the build (currently clean).

### Deliverables produced

- [SECURITY_REVIEW.md](SECURITY_REVIEW.md) — the security audit summary.
- [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md) — credential-gated integration
  checklist (11 integrations: creds, steps, expected result, failure symptoms).
- [SECURITY.md](SECURITY.md) — vulnerability disclosure policy.

## Fresh-install verification (passed)

`pnpm install`, `pnpm build`, `pnpm test` (2465), `pnpm lint`, `pnpm typecheck`,
and `pnpm format:check` all succeed on a clean tree. The **API service runs**:
`node apps/api/dist/main.js` listens and serves `/`, `/livez`, `/readyz`, and
`/metrics` with live request counts; `HOST=127.0.0.1` restricts the bind;
SIGTERM shuts down cleanly. The CLI is a framework (no bundled binary, by
design) — now documented as such.

## What was reviewed and deliberately left as-is

- **Duplication clusters** (`toError` ×8, `messageOf` ×3, a `retry-after` parser
  and header lookup ×2 each, plus the known sleep/`constantTimeEqual`) are
  **documented, not refactored**. Each copy is small, correct, and tested;
  consolidation would force foundational zero-dependency packages
  (`@hermes/kernel`, `@hermes/model`) to depend on a shared package — degrading
  a documented design property for marginal DRY gain. This matches the repo's
  existing rule-of-three discipline (RFC-0010 §7).
- **No dead code, no unfinished implementations** were found beyond two
  intentional scaffolds (`@hermes/shared`, `apps/telegram`), both explicitly
  labelled.

## Blockers to v1.0.0 (require the owner or infrastructure)

1. **LICENSE is empty** (`package.json` declares `"SEE LICENSE IN LICENSE"`).
   Choosing a license is an ownership decision that must not be invented. **This
   is the one hard blocker for a public release.** Once chosen, populate
   `LICENSE` (and set the `license` SPDX id in `package.json`).
2. **Ollama-native provider (#16)** is unbuilt (functionally covered by the
   OpenAI-compatible provider today). Decide whether v1.0.0 ships without the
   native provider — recommended **yes** (it is optional and infra-gated);
   update ROADMAP/STATUS to reflect the decision.
3. **Infra-gated verification** — run once, in an environment that has them:
   `docker build`/run answering `/livez`; the CI jobs on a PR; the release
   workflow on a `v*` tag. All are authored and correct; see
   [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md) §10–11.

## Non-blocking cleanup (recommended)

- Empty placeholder files remain committed: `VISION.md`, `CONSTITUTION.md`,
  `CLAUDE.md`, `.gitattributes`, and four empty `docs/` stubs (`adr/ADR-0001`,
  `architecture/system-overview`, `roadmap/phase-0`, `vision/000-introduction`).
  Fill or remove them — left untouched here to avoid inventing content or
  deleting intended work.

## Release steps once the license is chosen

1. Populate `LICENSE`; set the SPDX id in `package.json`.
2. Bump all `package.json` versions and `apps/api` `API_VERSION` to `1.0.0`
   (atomically), verify the gate, and commit.
3. Tag `v1.0.0`; the `Release` workflow builds and pushes the image.
4. Execute the infra-gated checks in `LIVE_VERIFICATION.md` and record results.

## Bottom line

HermesOS is **production-quality and release-ready in code** — deterministic,
strongly typed, comprehensively tested, security-hardened, and documented. The
first public **v1.0.0** tag is gated on one owner decision (the license) and a
one-time run of the infrastructure-dependent checks; nothing in the codebase
blocks it.
