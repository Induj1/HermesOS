# HermesOS Security Review

A point-in-time security review performed as part of production-readiness
verification. Scope: all `packages/*/src`, `apps/*/src`, `services/*/src`
(excluding tests), plus committed configuration (`Dockerfile`,
`docker-compose.yml`, `.github/workflows/*`, `.env.example`).

**Verdict: no High or Medium exploitable issues found.** The security-critical
surfaces are deliberately and correctly hardened. Two Low/defense-in-depth items
were found and **fixed**; a small number of by-design notes are recorded.

## Method

A structured audit across ten categories (secrets, randomness, command
injection, path traversal, SSRF, deserialization, prototype pollution, timing
attacks, unsafe defaults, dependency risk), each verified by reading the
implicated source. The standing boundary→control→risk map lives in
[`docs/security/audit.md`](docs/security/audit.md); this file records the review
and its resolutions.

## Findings and resolutions

### Fixed

| #   | Severity           | Finding                                                                                                                                                                                                                                                                                                                     | Resolution                                                                                                                                                                                                                                                                                                    |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Low (def-in-depth) | `git.clone` passed the URL to `git clone` unchecked. Git's `<transport>::<address>` remote-helper URLs (`ext::sh -c '…'`, `fd::`) make git **execute a command** — a clone URL becomes code execution. Gated behind `git:network`, but a model-produced URL should never run a command. (`packages/tools-git/src/tools.ts`) | Added `assertCloneUrlSafe` — the clone tool now rejects the `::` remote-helper form (and an empty URL) with a `GitError` `UNSAFE_URL` before invoking git. Normal `https`/`git`/`ssh`/`file` and scp-like `user@host:path` URLs pass; the pre-existing `--` flag-injection guard is unchanged. 3 tests added. |
| 2   | Low                | The API server bound `0.0.0.0` with no way to restrict the interface. (`apps/api/src/main.ts`)                                                                                                                                                                                                                              | Added a `HOST` config var (default `0.0.0.0`, so a container's published port stays reachable); `HOST=127.0.0.1` binds loopback only on bare metal.                                                                                                                                                           |

### By-design / accepted (no change)

- **`isPrivateHost` matches IP literals, not DNS-resolved addresses**
  (`packages/tools-http/src/policy.ts`). A public hostname that resolves to a
  private IP is not caught by the literal check; the **host allowlist** is the
  intended defense for untrusted URLs, and decimal/hex IP encodings are
  normalized by the WHATWG `URL` parser before the check. Documented in the
  source. Accepted.
- **SQL string fragments in `services/memory`** are hardcoded column identifiers
  and a two-branch `ORDER BY`; all values are parameterized (`$1`,
  `ANY($1::uuid[])`). Not injectable. Accepted.

## What is already hardened (verified)

- **Secrets** — none in source; only `.env.example` is tracked, with `CHANGE_ME`
  placeholders. Docker/compose source all credentials from the environment with
  fail-loud guards; the image bakes in nothing and runs `USER node`.
- **Randomness** — no `Math.random()` anywhere. Ids use `crypto.randomUUID()`;
  trace/span ids use `crypto.randomBytes`.
- **Command execution** — a single spawner, `spawn(cmd, argv, { shell: false })`
  with a minimal `PATH`-only environment. No shell string anywhere.
- **Path traversal** — pure-string containment (`resolveWithin`, `confine`) with
  no `realpath`, so no TOCTOU; every fs/git operation is wrapped.
- **SSRF** — scheme allowlist, optional host allowlist, private/loopback/
  link-local block (incl. `169.254.169.254`), re-checked on **every redirect
  hop** with relative-`Location` resolution.
- **Deserialization** — no `eval`/`new Function`/`vm`. `JSON.parse` reads into
  typed shapes; the GitHub webhook body is parsed only **after** signature
  verification.
- **Prototype pollution** — no untrusted deep-merge; no
  `__proto__`/`constructor` key handling.
- **Timing attacks** — all three secret comparisons are constant-time
  (`@hermes/auth`, `@hermes/telegram` pure-JS; `@hermes/tools-github` via
  `crypto.timingSafeEqual`).
- **Authorization** — default-deny with deny-override; a policy bug fails
  closed.
- **Dependencies** — exactly one non-`@hermes/*` runtime dependency in the whole
  monorepo (`pg` in `@hermes/memory`); everything else is
  zero-runtime-dependency.

## Residual (tracked, not blocking)

- Symlink resolution in `@hermes/tools-fs` is reported, not resolved (RFC-0007
  §7.1) — best-effort containment.
- Loaded plugins run with the full `PluginContext` (no sandbox, by design —
  RFC-0032); version compatibility is enforced, capability isolation is not.
- Live webhook-signature hardening (GitHub, Telegram) needs real secrets to
  confirm against genuine deliveries — see `LIVE_VERIFICATION.md`.

## Dependency audit result

`pnpm audit` (production and full dependency sets) reports **no known
vulnerabilities**. A `pnpm audit --prod` job now runs in CI, so a
newly-disclosed vulnerability in a production dependency fails the build.
