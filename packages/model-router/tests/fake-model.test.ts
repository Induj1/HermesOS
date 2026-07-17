/**
 * The scriptable fake chat model.
 */

import { describe, expect, it } from 'vitest';
import { RateLimitedError, user } from '@hermes/model';
import { FakeChatModel, chatOnly, response } from '../src/fake-model.js';

const msgs = [user('hi')];

describe('FakeChatModel', () => {
  it('returns a canned success by default and records the call', async () => {
    const m = new FakeChatModel({ name: 'm', provider: 'p' });
    const r = await m.chat(msgs);
    expect(r).toMatchObject({ stopReason: 'stop', model: 'm' });
    expect(m.calls).toEqual([{ kind: 'chat', messages: msgs }]);
  });

  it('consumes a script in order, then falls back to always', async () => {
    const m = new FakeChatModel({
      name: 'm',
      provider: 'p',
      script: [response({ content: 'first' }), new RateLimitedError('p')],
      always: response({ content: 'default' }),
    });
    expect((await m.chat(msgs)).content).toBe('first');
    await expect(m.chat(msgs)).rejects.toBeInstanceOf(RateLimitedError);
    expect((await m.chat(msgs)).content).toBe('default');
  });

  it('records chatWithTools calls distinctly', async () => {
    const m = new FakeChatModel({ name: 'm', provider: 'p' });
    await m.chatWithTools(msgs, []);
    expect(m.calls[0]?.kind).toBe('tools');
  });

  it('declares configurable capabilities', () => {
    const m = new FakeChatModel({
      name: 'm',
      provider: 'p',
      supports: { chat: true, tools: false, streaming: true },
    });
    expect(m.info.supports).toEqual({ chat: true, tools: false, streaming: true });
  });
});

describe('chatOnly', () => {
  it('has no chatWithTools and declares tools:false', async () => {
    const m = chatOnly({ name: 'c', provider: 'ollama' });
    expect('chatWithTools' in m).toBe(false);
    expect(m.info.supports.tools).toBe(false);
    expect((await m.chat(msgs)).model).toBe('c');
  });

  it('can declare streaming', () => {
    expect(
      chatOnly({ name: 'c', provider: 'p', streaming: true }).info.supports.streaming,
    ).toBe(true);
  });
});

describe('response', () => {
  it('builds a response with overrides', () => {
    expect(response({ content: 'x', model: 'y' })).toEqual({
      content: 'x',
      stopReason: 'stop',
      model: 'y',
    });
  });
});
