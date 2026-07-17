/**
 * The shared model-resolution helper.
 */

import { describe, expect, it } from 'vitest';
import { resolveModel, type EmbeddingProvider } from '../src/provider.js';
import { UnknownModelError } from '../src/errors.js';
import type { EmbeddingModel } from '../src/types.js';

const model = (name: string, dimensions = 8): EmbeddingModel => ({
  name,
  provider: 'p',
  dimensions,
  capabilities: {
    maxBatchSize: 4,
    configurableDimensions: false,
    normalizesByDefault: false,
  },
});

const providerWith = (models: EmbeddingModel[]): EmbeddingProvider => ({
  info: { name: 'p' },
  models: () => models,
  capabilities: () =>
    models[0]?.capabilities ?? {
      maxBatchSize: 1,
      configurableDimensions: false,
      normalizesByDefault: false,
    },
  embed: () => Promise.reject(new Error('not used')),
});

describe('resolveModel', () => {
  it('returns the first model as the default', () => {
    expect(resolveModel(providerWith([model('a'), model('b')])).name).toBe('a');
  });

  it('returns a named model', () => {
    expect(
      resolveModel(providerWith([model('a'), model('b', 16)]), 'b').dimensions,
    ).toBe(16);
  });

  it('throws for a named model the provider does not serve', () => {
    expect(() => resolveModel(providerWith([model('a')]), 'ghost')).toThrow(
      UnknownModelError,
    );
  });

  it('throws for the default when the provider serves no models', () => {
    expect(() => resolveModel(providerWith([]))).toThrow(UnknownModelError);
  });
});
