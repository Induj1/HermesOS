/**
 * Loading a set of named secrets — the counterpart to config's schema load.
 *
 * A service declares the secrets it needs by name; `loadSecrets(source, names)`
 * resolves them all and returns either every value wrapped in a `Secret`, or the
 * complete list of the ones that are missing — one pass, so an operator sees all
 * the gaps at once instead of one restart per missing secret. Optional secrets
 * (absent is fine) resolve to `undefined`.
 */

import { Secret } from './secret.js';
import type { SecretSource } from './source.js';

/** The result of loading required secrets: the wrapped values, or what is missing. */
export type SecretsResult<K extends string> =
  | { readonly ok: true; readonly value: Readonly<Record<K, Secret>> }
  | { readonly ok: false; readonly missing: readonly K[] };

/** Resolve required secrets by name. Reports every missing name in one pass. */
export async function loadSecrets<K extends string>(
  source: SecretSource,
  names: readonly K[],
): Promise<SecretsResult<K>> {
  const value = {} as Record<K, Secret>;
  const missing: K[] = [];

  for (const name of names) {
    const raw = await source.load(name);
    if (raw === undefined) {
      missing.push(name);
    } else {
      value[name] = new Secret(raw);
    }
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value };
}

/** Thrown by `loadSecretsOrThrow`; `missing` carries the structured detail. */
export class MissingSecretsError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`missing required secrets: ${missing.join(', ')}`);
    this.name = 'MissingSecretsError';
    this.missing = missing;
  }
}

/** Resolve required secrets, throwing a `MissingSecretsError` if any are absent. */
export async function loadSecretsOrThrow<K extends string>(
  source: SecretSource,
  names: readonly K[],
): Promise<Readonly<Record<K, Secret>>> {
  const result = await loadSecrets(source, names);
  if (!result.ok) throw new MissingSecretsError(result.missing);
  return result.value;
}

/** Resolve one optional secret: a `Secret` if present, else `undefined`. */
export async function loadOptionalSecret(
  source: SecretSource,
  name: string,
): Promise<Secret | undefined> {
  const raw = await source.load(name);
  return raw === undefined ? undefined : new Secret(raw);
}
