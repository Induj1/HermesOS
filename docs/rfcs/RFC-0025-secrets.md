# RFC-0025: Secrets

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| Status        | Implemented                            |
| Date          | 2026-07-18                             |
| Scope         | `packages/secrets` (`@hermes/secrets`) |
| Depends on    | — (zero dependencies)                  |
| Supersedes    | —                                      |
| Superseded by | —                                      |

Design record for secret sourcing and leak-resistant handling.

Covered by 30 tests in `packages/secrets/tests`.

---

## 1. Context

Configuration (#24, RFC-0024) marks which fields are secret and masks them in a
logged view. But the value of a secret still has to be _sourced_ from somewhere
secure and _carried_ through the program without leaking. Those are two distinct
concerns this package owns, keeping `@hermes/config` a pure typed loader:

1. **Where the value comes from** — the environment, a mounted secret file, or a
   chain of both.
2. **How the value is carried** — wrapped so it cannot reach a log, an error, or
   a JSON body by accident.

Zero dependencies: this is a wrapper class and a few source adapters, not a
vault client. A real vault (AWS/GCP/Vault) is a future `SecretSource` adapter,
not a reason to pull an SDK into the core.

## 2. The `Secret` wrapper

`Secret` is an opaque holder. The value comes out only through an explicit
`.expose()`; every path by which a value _accidentally_ escapes is overridden to
render `[redacted]`:

- `toString` and template interpolation,
- `JSON.stringify` (via `toJSON`),
- Node's `util.inspect` / `console.log` (via the well-known
  `nodejs.util.inspect.custom` symbol, referenced by name so no `node:util`
  import is needed).

This makes the leak-resistant path the _default_: "someone logged the config
object and leaked the API key" stops being possible without a deliberate
`.expose()` at the one place the raw value is genuinely needed (an
`Authorization` header, a database driver). `isSecret` is the type guard.

## 3. Sources

`SecretSource` is a port — `load(name)` yields the raw value or `undefined` when
that source lacks it. Adapters cover how deployments actually deliver secrets:

- **`MemorySecretSource`** — an in-memory map; the deterministic test double.
- **`EnvSecretSource`** — a process-environment record, with the Docker/Compose
  **`NAME_FILE` convention**: if `NAME` is unset but `NAME_FILE` points at a
  file, its trimmed contents are the secret. That is how a secret stays out of
  the environment (and out of `docker inspect`) while still being injected.
- **`FileSecretSource`** — a directory of one-file-per-secret (`<dir>/<name>`),
  the shape of a Docker or Kubernetes secret mount (`/run/secrets/<name>`).
- **`ChainSecretSource`** — try several sources in order; first hit wins (env
  overrides file mounts, or vice-versa, by ordering).

A blank or whitespace-only value is treated as **absent**, matching config: an
empty variable means "not set", not "the empty string". File and environment
access is injected (`FileReader`, the env record), so every branch is testable
without real I/O; `nodeFileReader` in `node.ts` is the only piece that touches
the filesystem. A missing file there resolves to `undefined` (an absent secret);
any other error — a permissions problem, a directory where a file was expected —
propagates, because it is a misconfiguration the operator must see.

## 4. Loading a declared set

Mirroring config's schema load, a service declares the secrets it needs by name
and `loadSecrets(source, names)` resolves them all, returning either every value
wrapped in a `Secret` or the **complete list of what is missing** — one pass, so
an operator sees every gap at once instead of one restart per missing secret.
`loadSecretsOrThrow` is the fail-fast form (`MissingSecretsError` carries the
structured `.missing`), and `loadOptionalSecret` handles the absent-is-fine
case.

## 5. Non-goals

- **No vault client.** AWS Secrets Manager, GCP Secret Manager, and HashiCorp
  Vault are future `SecretSource` adapters over injected transports (the same
  shape the providers use), not core.
- **No rotation or leasing.** Secrets are read at startup. A rotated secret is a
  restart, matching the configuration model.
- **No encryption at rest.** That is the deployment's responsibility (a mounted
  tmpfs secret, a KMS-backed store); this package handles values already
  decrypted into the process.

## 6. Testing

30 tests: the `Secret` wrapper across every leak path (`toString`, template,
`JSON.stringify`, `util.inspect`) and a "never contains the raw value" sweep;
each source including the `NAME_FILE` fallback and precedence, trailing-slash
normalization, blank-as-absent, and the empty chain; the all-missing-at-once
load and both throw/optional forms; and the Node `FileReader` against a real
temp file (present, ENOENT → undefined, EISDIR → throws). 100% branch coverage.
