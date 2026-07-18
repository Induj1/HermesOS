# @hermes/config

Typed, validated configuration loaded from the environment — declare a schema
once, get back either a fully typed object or the complete list of what is
wrong.

- **Design record:** [RFC-0024](../../docs/rfcs/RFC-0024-config.md).
- **Depends on:** nothing.

## Usage

```ts
import {
  boolean,
  loadConfigFromEnv,
  oneOf,
  port,
  redactedView,
  url,
} from '@hermes/config';

const schema = {
  port: port().default(3000),
  databaseUrl: url().secret().describe('Postgres connection string'),
  logLevel: oneOf(['debug', 'info', 'warn', 'error']).default('info'),
  metricsEnabled: boolean().default(true),
};

// Reads process.env; throws a ConfigError listing every problem on failure.
const cfg = loadConfigFromEnv(schema);
cfg.port; // number      (from PORT, default 3000)
cfg.databaseUrl; // string      (from DATABASE_URL, required)
cfg.logLevel; // 'debug' | 'info' | 'warn' | 'error'

// Safe to log on boot — secret fields are masked.
console.log(redactedView(schema, cfg));
// { port: '3000', databaseUrl: '***', logLevel: 'info', metricsEnabled: 'true' }
```

For tests, load against a plain record instead of the real environment:

```ts
import { loadConfig } from '@hermes/config';

const result = loadConfig(schema, { DATABASE_URL: 'postgres://localhost/db' });
if (!result.ok) {
  for (const e of result.errors) console.error(`${e.envVar}: ${e.message}`);
}
```

## Fields

`string` · `number` · `integer` · `port` · `boolean` · `url` · `oneOf([...])` ·
`list`. Each supports `.optional()`, `.default(v)`, `.secret()`,
`.describe(text)`, and `.from(ENV_VAR)`. Fields are immutable — every modifier
returns a new field.

## Design notes

- **Env-var names** derive from the property key in SCREAMING_SNAKE_CASE
  (`databaseUrl` → `DATABASE_URL`), or an explicit `.from(...)`.
- **All errors at once:** `loadConfig` reports every invalid or missing variable
  in one pass, not just the first.
- **Deterministic core:** `loadConfig` and the fields are a pure function of an
  injected `EnvSource`; only `processEnv`/`loadConfigFromEnv` read
  `process.env`.
- **Docs & redaction:** `describeSchema(schema)` generates a configuration
  reference from the schema alone; `redactedView(schema, value)` masks secrets
  for logging.
