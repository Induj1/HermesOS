/**
 * @hermes/config — Typed, validated configuration loaded from the environment.
 *
 * Declare a schema with the field builders, then `loadConfig(schema, env)` to
 * get either the fully typed config or the complete list of what is wrong:
 *
 * ```ts
 * const schema = {
 *   port: port().default(3000),
 *   databaseUrl: url().secret().describe('Postgres connection string'),
 *   logLevel: oneOf(['debug', 'info', 'warn', 'error']).default('info'),
 * };
 * const cfg = loadConfigOrThrow(schema, processEnv());
 * cfg.port; // number   cfg.databaseUrl; // string   cfg.logLevel; // 'debug' | ...
 * ```
 *
 * The core (`loadConfig`, the fields) is a pure function of an injected
 * environment record; `processEnv`/`loadConfigFromEnv` are the only functions
 * that read `process.env`.
 */

export {
  Field,
  boolean,
  err,
  integer,
  list,
  number,
  ok,
  oneOf,
  port,
  string,
  url,
  type FieldMeta,
  type ParseResult,
} from './field.js';

export {
  ConfigError,
  describeSchema,
  envVarName,
  loadConfig,
  loadConfigOrThrow,
  redactedView,
  type Config,
  type EnvSource,
  type FieldDoc,
  type FieldError,
  type LoadResult,
  type Schema,
} from './load.js';

export { loadConfigFromEnv, processEnv } from './env.js';
