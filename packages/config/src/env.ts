/**
 * The process-environment adapter — the one place this package touches Node's
 * `process.env`. Keeping it isolated lets `load.ts` stay a pure function of an
 * injected record, so every parsing and validation branch is tested against a
 * plain object with no global state.
 */

import type { Config, EnvSource, Schema } from './load.js';
import { loadConfigOrThrow } from './load.js';

/** A snapshot of `process.env` as an `EnvSource`. */
export function processEnv(): EnvSource {
  return { ...process.env };
}

/** Load configuration from the real process environment, throwing on failure. */
export function loadConfigFromEnv<S extends Schema>(schema: S): Config<S> {
  return loadConfigOrThrow(schema, processEnv());
}
