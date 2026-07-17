/**
 * Candidate selection — the routing policy, tested without invoking a model.
 */

import { describe, expect, it } from 'vitest';
import { ModelRegistry } from '../src/registry.js';
import { selectCandidates } from '../src/selection.js';
import { FakeChatModel, chatOnly } from '../src/fake-model.js';

const openaiTools = new FakeChatModel({ name: 'gpt', provider: 'openai' });
const anthropicTools = new FakeChatModel({ name: 'claude', provider: 'anthropic' });
const ollamaChat = chatOnly({ name: 'llama', provider: 'ollama' });

const registry = new ModelRegistry()
  .register(ollamaChat)
  .register(openaiTools)
  .register(anthropicTools);

const names = (models: readonly { info: { name: string } }[]): string[] =>
  models.map((m) => m.info.name);

describe('selectCandidates', () => {
  it('returns all in registration order with no criteria', () => {
    expect(names(selectCandidates(registry))).toEqual(['llama', 'gpt', 'claude']);
  });

  it('filters by required features', () => {
    expect(names(selectCandidates(registry, { features: { tools: true } }))).toEqual([
      'gpt',
      'claude',
    ]);
  });

  it('filters by provider', () => {
    expect(names(selectCandidates(registry, { provider: 'ollama' }))).toEqual([
      'llama',
    ]);
  });

  it('uses an explicit model list as the order', () => {
    expect(names(selectCandidates(registry, { models: ['claude', 'llama'] }))).toEqual([
      'claude',
      'llama',
    ]);
  });

  it('drops names that are unregistered or fail the filters', () => {
    expect(
      names(
        selectCandidates(registry, {
          models: ['ghost', 'llama', 'gpt'],
          features: { tools: true },
        }),
      ),
    ).toEqual(['gpt']);
  });

  it('combines provider and features', () => {
    expect(
      names(
        selectCandidates(registry, {
          provider: 'anthropic',
          features: { tools: true },
        }),
      ),
    ).toEqual(['claude']);
    expect(
      selectCandidates(registry, { provider: 'ollama', features: { tools: true } }),
    ).toHaveLength(0);
  });
});
