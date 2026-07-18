/**
 * Loading — turn a schema plus an environment record into typed configuration.
 *
 * A `Schema` maps property names to `Field`s. `loadConfig` looks each field up
 * in an injected environment record (never `process.env` directly — that lives
 * in `env.ts`, so this module is pure and deterministic), resolves every field,
 * and returns *either* the fully typed config *or the complete list of errors*.
 * Gathering all errors matters: an operator fixing a misconfigured deployment
 * wants every missing variable at once, not one restart per typo.
 *
 * The environment variable for a field is its explicit `.from(...)` name, or the
 * property key converted to SCREAMING_SNAKE_CASE (`databaseUrl` → `DATABASE_URL`).
 */

import type { Field, FieldMeta } from './field.js';

/** A record read from the process environment (or a test double). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** A configuration shape: property names to fields. */
export type Schema = Readonly<Record<string, Field<unknown>>>;

/** The typed configuration a schema produces. */
export type Config<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends Field<infer T> ? T : never;
};

/** One field that failed to load. */
export interface FieldError {
  /** The schema property name. */
  readonly key: string;
  /** The environment variable that was consulted. */
  readonly envVar: string;
  /** Why it failed (missing, wrong type, out of range, …). */
  readonly message: string;
}

/** The result of loading: the typed config, or every error found. */
export type LoadResult<S extends Schema> =
  | { readonly ok: true; readonly value: Config<S> }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/** Derive `DATABASE_URL` from `databaseUrl`, `port` from `port`, etc. */
export function envVarName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\- ]+/g, '_')
    .toUpperCase();
}

/** Resolve the environment variable a field reads for a given key. */
function envVarFor(key: string, meta: FieldMeta): string {
  return meta.envVar ?? envVarName(key);
}

/**
 * Load and validate configuration. Returns the typed value on success, or the
 * full list of field errors — one pass, every problem reported.
 */
export function loadConfig<S extends Schema>(schema: S, env: EnvSource): LoadResult<S> {
  const value: Record<string, unknown> = {};
  const errors: FieldError[] = [];

  for (const [key, fieldDef] of Object.entries(schema)) {
    const envVar = envVarFor(key, fieldDef.meta());
    const result = fieldDef.resolve(env[envVar]);
    if (result.ok) {
      value[key] = result.value;
    } else {
      errors.push({ key, envVar, message: result.message });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as Config<S> };
}

/** Thrown by `loadConfigOrThrow`; `errors` carries the structured detail. */
export class ConfigError extends Error {
  readonly errors: readonly FieldError[];

  constructor(errors: readonly FieldError[]) {
    super(
      `invalid configuration:\n${errors
        .map((e) => `  - ${e.envVar}: ${e.message}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/** Load configuration, throwing a `ConfigError` listing every problem on failure. */
export function loadConfigOrThrow<S extends Schema>(
  schema: S,
  env: EnvSource,
): Config<S> {
  const result = loadConfig(schema, env);
  if (!result.ok) throw new ConfigError(result.errors);
  return result.value;
}

/** One field's documentation row. */
export interface FieldDoc {
  readonly key: string;
  readonly envVar: string;
  readonly type: string;
  readonly required: boolean;
  readonly default: string | undefined;
  readonly secret: boolean;
  readonly description: string;
}

/**
 * Describe a schema for a configuration reference — purely from the schema, with
 * no environment and no values, so it is safe to generate docs from at any time.
 */
export function describeSchema(schema: Schema): readonly FieldDoc[] {
  return Object.entries(schema).map(([key, fieldDef]) => {
    const meta = fieldDef.meta();
    return {
      key,
      envVar: meta.envVar ?? envVarName(key),
      type: meta.typeName,
      required: meta.required,
      default: meta.defaultLabel,
      secret: meta.secret,
      description: meta.description,
    };
  });
}

/**
 * A view of loaded configuration safe to log: secret fields are masked. Values
 * are rendered as strings; a masked field reads `***` regardless of its length,
 * so nothing about the secret leaks.
 */
export function redactedView<S extends Schema>(
  schema: S,
  value: Config<S>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, fieldDef] of Object.entries(schema)) {
    const isSecret = fieldDef.meta().secret;
    const v = (value as Record<string, unknown>)[key];
    out[key] = isSecret && v !== undefined ? '***' : renderValue(v);
  }
  return out;
}

function renderValue(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // The only remaining loaded field type is a string list.
  return (v as readonly string[]).join(',');
}
