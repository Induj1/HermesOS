# @hermes/secrets

Secret sourcing and leak-resistant handling — source secrets from the
environment or mounted files, and wrap them so they never leak by accident.

- **Design record:** [RFC-0025](../../docs/rfcs/RFC-0025-secrets.md).
- **Depends on:** nothing.

## Usage

```ts
import {
  ChainSecretSource,
  EnvSecretSource,
  FileSecretSource,
  loadSecretsOrThrow,
  nodeFileReader,
} from '@hermes/secrets';

const source = new ChainSecretSource([
  new EnvSecretSource(process.env, nodeFileReader()), // NAME and NAME_FILE
  new FileSecretSource('/run/secrets', nodeFileReader()), // Docker/K8s mounts
]);

const secrets = await loadSecretsOrThrow(source, [
  'OPENAI_API_KEY',
  'DATABASE_URL',
]);

// The value comes out only through .expose(), at the point of use:
await fetch(url, {
  headers: { authorization: `Bearer ${secrets.OPENAI_API_KEY.expose()}` },
});

// Everywhere else it is inert:
console.log(secrets); // { OPENAI_API_KEY: Secret([redacted]), ... }
JSON.stringify(secrets); // {"OPENAI_API_KEY":"[redacted]", ...}
```

## The `Secret` wrapper

`Secret` renders `[redacted]` under `toString`, template interpolation,
`JSON.stringify`, and `console.log` / `util.inspect`. The raw value escapes only
through the explicit `.expose()` — so the safe path is the default, and a leak
takes a deliberate call, not a forgotten one.

## Sources

- `MemorySecretSource(map)` — the deterministic test double.
- `EnvSecretSource(env, readFile?)` — env variables, plus the Docker `NAME_FILE`
  convention (`TOKEN_FILE=/run/secrets/token`).
- `FileSecretSource(dir, readFile)` — one file per secret (`<dir>/<name>`).
- `ChainSecretSource([...])` — first source that has the secret wins.

`nodeFileReader()` is the Node filesystem-backed `FileReader`; the sources
themselves are pure functions of an injected reader and env record.

## Loading

- `loadSecrets(source, names)` → `{ ok, value }` or `{ ok: false, missing }` —
  every missing secret reported in one pass.
- `loadSecretsOrThrow(source, names)` — throws `MissingSecretsError` if any are
  absent.
- `loadOptionalSecret(source, name)` — a `Secret` or `undefined`.
