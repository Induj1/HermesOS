/**
 * The registry and its capability/provider lookups.
 */

import { describe, expect, it } from 'vitest';
import { ModelRegistry, supportsAll } from '../src/registry.js';
import { FakeChatModel, chatOnly } from '../src/fake-model.js';

const tools = new FakeChatModel({ name: 'tools-model', provider: 'openai' });
const chatModel = chatOnly({ name: 'chat-model', provider: 'ollama' });

describe('ModelRegistry', () => {
  it('registers, gets, and lists in order', () => {
    const r = new ModelRegistry().register(tools).register(chatModel);
    expect(r.get('tools-model')).toBe(tools);
    expect(r.has('chat-model')).toBe(true);
    expect(r.list().map((m) => m.info.name)).toEqual(['tools-model', 'chat-model']);
  });

  it('registerAll adds many', () => {
    const r = new ModelRegistry().registerAll([tools, chatModel]);
    expect(r.list()).toHaveLength(2);
  });

  it('re-registering a name replaces it', () => {
    const replacement = new FakeChatModel({
      name: 'tools-model',
      provider: 'anthropic',
    });
    const r = new ModelRegistry().register(tools).register(replacement);
    expect(r.get('tools-model')?.info.provider).toBe('anthropic');
    expect(r.list()).toHaveLength(1);
  });

  it('returns undefined for an unknown name', () => {
    expect(new ModelRegistry().get('nope')).toBeUndefined();
    expect(new ModelRegistry().has('nope')).toBe(false);
  });

  it('infos exposes the ModelInfos', () => {
    const r = new ModelRegistry().register(tools);
    expect(r.infos()).toEqual([tools.info]);
  });

  it('byProvider filters by provider', () => {
    const r = new ModelRegistry().register(tools).register(chatModel);
    expect(r.byProvider('ollama').map((m) => m.info.name)).toEqual(['chat-model']);
  });

  it('byFeatures returns models supporting every demanded feature', () => {
    const r = new ModelRegistry().register(tools).register(chatModel);
    expect(r.byFeatures({ tools: true }).map((m) => m.info.name)).toEqual([
      'tools-model',
    ]);
    expect(r.byFeatures({ chat: true }).map((m) => m.info.name)).toEqual([
      'tools-model',
      'chat-model',
    ]);
  });
});

describe('supportsAll', () => {
  const feats = { chat: true, tools: false, streaming: true };
  it('is satisfied when every demanded feature is present', () => {
    expect(supportsAll(feats, { chat: true, streaming: true })).toBe(true);
  });
  it('fails when a demanded feature is missing', () => {
    expect(supportsAll(feats, { tools: true })).toBe(false);
  });
  it('ignores features not demanded (false/unset)', () => {
    expect(supportsAll(feats, { tools: false })).toBe(true);
    expect(supportsAll(feats, {})).toBe(true);
  });
});
