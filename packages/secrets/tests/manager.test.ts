/**
 * Loading named secrets — all-missing-at-once, wrapping, and the optional path.
 */

import { describe, expect, it } from 'vitest';
import {
  MissingSecretsError,
  loadOptionalSecret,
  loadSecrets,
  loadSecretsOrThrow,
} from '../src/manager.js';
import { isSecret } from '../src/secret.js';
import { MemorySecretSource } from '../src/source.js';

const source = new MemorySecretSource({
  OPENAI_API_KEY: 'sk-1',
  DATABASE_URL: 'postgres://x/y',
});

describe('loadSecrets', () => {
  it('wraps every present secret in a Secret', async () => {
    const result = await loadSecrets(source, ['OPENAI_API_KEY', 'DATABASE_URL']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isSecret(result.value.OPENAI_API_KEY)).toBe(true);
      expect(result.value.DATABASE_URL.expose()).toBe('postgres://x/y');
    }
  });

  it('reports every missing secret in one pass', async () => {
    const result = await loadSecrets(source, [
      'OPENAI_API_KEY',
      'MISSING_A',
      'MISSING_B',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([...result.missing].sort()).toEqual(['MISSING_A', 'MISSING_B']);
    }
  });
});

describe('loadSecretsOrThrow', () => {
  it('returns the wrapped values when all are present', async () => {
    const secrets = await loadSecretsOrThrow(source, ['OPENAI_API_KEY']);
    expect(secrets.OPENAI_API_KEY.expose()).toBe('sk-1');
  });

  it('throws a MissingSecretsError listing what is absent', async () => {
    await expect(loadSecretsOrThrow(source, ['NOPE', 'ALSO_NOPE'])).rejects.toThrow(
      MissingSecretsError,
    );
    try {
      await loadSecretsOrThrow(source, ['NOPE']);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingSecretsError);
      const err = e as MissingSecretsError;
      expect(err.name).toBe('MissingSecretsError');
      expect(err.missing).toEqual(['NOPE']);
      expect(err.message).toMatch(/NOPE/);
    }
  });
});

describe('loadOptionalSecret', () => {
  it('returns a Secret when present', async () => {
    const s = await loadOptionalSecret(source, 'OPENAI_API_KEY');
    expect(s?.expose()).toBe('sk-1');
  });

  it('returns undefined when absent', async () => {
    expect(await loadOptionalSecret(source, 'MISSING')).toBeUndefined();
  });
});
