# HermesOS Security Audit (#38)

A standing record of the system's trust boundaries, the control at each, and the
residual risk. This milestone **reviews and documents**; it adds no features. It
is meant to be re-read and updated as subsystems change.

Legend for residual risk: **Low** (defended in depth, narrow surface),
**Medium** (defended, but depends on correct configuration), **Gated** (the
control is implemented and tested against a fake; live hardening needs a
credential or real infrastructure).

## 1. Trust boundaries and controls

| #   | Boundary                    | Surface                                                 | Control                                                                                                                                                                       | Residual                                                                                |
| --- | --------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Outbound HTTP               | An agent/tool fetches an attacker-influenced URL (SSRF) | `@hermes/tools-http` `HostPolicy` blocks private/loopback/link-local ranges and re-checks **every redirect hop**; a response size cap; a timeout (RFC-0009)                   | Low                                                                                     |
| 2   | Shell execution             | A tool runs an external command                         | `@hermes/tools-shell` uses **argv, never a shell string** (no interpolation), an allowlist, output/timeout caps, and env isolation (RFC-0008)                                 | Low                                                                                     |
| 3   | Filesystem                  | A tool reads/writes an attacker-influenced path         | `@hermes/tools-fs` roots every path; traversal outside the root is rejected as a string operation (RFC-0007)                                                                  | Medium — symlinks are reported, not resolved (RFC-0007 §7.1)                            |
| 4   | Tool permissions            | A model invokes a tool it should not                    | `@hermes/tools` permission grades + `toolset({ granted })`; a denied tool refuses at call time rather than vanishing (RFC-0006)                                               | Medium — the _host_ must supply an authorization story; unguarded is the honest default |
| 5   | Inbound webhooks (GitHub)   | A forged webhook delivery                               | HMAC signature verification (`@hermes/tools-github`) (RFC-0011)                                                                                                               | Gated — needs a real secret to confirm live                                             |
| 6   | Inbound webhooks (Telegram) | A forged webhook delivery                               | `verifyWebhook` constant-time secret-token check (`@hermes/telegram`, RFC-0034)                                                                                               | Gated — needs a real secret to confirm live                                             |
| 7   | Authentication              | An unauthenticated or spoofed caller                    | `@hermes/auth`: opaque API keys compared **constant-time**, uniform `401`, `Principal` carries no secret (RFC-0029)                                                           | Medium — only API-key/bearer today; signed-token/OAuth are future adapters              |
| 8   | Authorization               | A caller acting beyond its grants                       | `@hermes/authz`: **default-deny, deny-override** policy engine; wildcard scopes are trailing-only (RFC-0030)                                                                  | Low — fails closed by construction                                                      |
| 9   | Secret handling             | A key leaks into a log/error/response                   | `@hermes/secrets` `Secret` renders `[redacted]` under `toString`/`JSON`/`inspect`; `@hermes/config` `redactedView`; the Telegram client keeps the token out of error messages | Low                                                                                     |
| 10  | Secret sourcing             | A secret sits in the environment / image                | `@hermes/secrets` supports the Docker `NAME_FILE` convention and file-mounted secrets; the Docker image bakes in **no** secrets (config from env)                             | Medium — depends on the deployment mounting secrets, not setting plain env              |
| 11  | Plugin loading              | A third-party plugin built for another host             | `@hermes/plugin-loader` enforces semver API compatibility and manifest validity **before** `setup` runs (RFC-0032)                                                            | Medium — a loaded plugin runs with the full `PluginContext` (no sandbox, by design)     |
| 12  | REST error surface          | A stack/secret leaks to a client                        | `@hermes/rest` error boundary: `HttpError` → JSON, any other throw → a leak-free `500` (RFC-0022)                                                                             | Low                                                                                     |
| 13  | Container runtime           | A compromised process has broad rights                  | The image runs as the unprivileged `node` user, not root (Dockerfile, #36)                                                                                                    | Gated — needs a real build/run to confirm                                               |

## 2. Dependency audit

`pnpm audit` should run in CI (#37) and be clean or explicitly triaged. The
dependency surface is deliberately tiny: most packages are **zero-runtime-
dependency**, and the few that touch I/O (`node:fs`, `node:crypto`, `node:http`)
use the platform, not third-party libraries — so the transitive attack surface
is dominated by the toolchain (TypeScript, Vitest, ESLint), which does not ship
in the production image.

**Result (this review):** `pnpm audit` reports **no known vulnerabilities** for
both production and full dependency sets. `pnpm audit --prod` now runs as a CI
job (`.github/workflows/ci.yml`), so a newly-disclosed vulnerability in a
production dependency fails the build; triage findings here.

## 3. Cross-cutting observations

- **Determinism aids audit.** Because subsystems are pure functions of injected
  clocks/transports, a security-relevant path (redirect re-check, constant-time
  compare, default-deny) is exercised by a deterministic test, not left to a
  live-only code path.
- **Fail-closed defaults.** Authorization defaults to deny; a denied tool
  refuses rather than disappearing; a corrupt `traceparent`/webhook starts fresh
  rather than trusting a forged value.
- **Least privilege in the image.** No secrets baked in, non-root user,
  production-only dependencies via `pnpm deploy`.

## 4. Open items (residual, tracked)

1. **Symlink resolution** in `@hermes/tools-fs` (boundary #3) — best-effort
   today; a resolving check is a hardening follow-up.
2. **Live webhook hardening** (#5, #6) — needs real secrets to confirm the
   signature paths against genuine deliveries.
3. **Plugin sandboxing** (#11) — out of scope for version enforcement; a
   worker-isolated or capability-filtered loader is a future option.
4. **`pnpm audit` in CI** — wire the step and triage findings here.
