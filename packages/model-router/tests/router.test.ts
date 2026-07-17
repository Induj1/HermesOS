/**
 * The router — selection, fallback on retryable failures, and stopping on
 * definitive ones.
 */

import { describe, expect, it } from 'vitest';
import {
  RateLimitedError,
  InvalidRequestError,
  ModelUnavailableError,
} from '@hermes/model';
import { ModelRegistry } from '../src/registry.js';
import { route, RoutingChatModel } from '../src/router.js';
import { AllFailedError, NoCandidatesError, type RouteAttempt } from '../src/errors.js';
import { FakeChatModel, chatOnly, response } from '../src/fake-model.js';
import { user } from '@hermes/model';

const msgs = [user('hello')];

describe('route (the engine)', () => {
  it('throws NoCandidatesError for an empty list', async () => {
    await expect(route([], () => Promise.resolve('x'))).rejects.toBeInstanceOf(
      NoCandidatesError,
    );
  });

  it('returns the first success', async () => {
    const a = new FakeChatModel({ name: 'a', provider: 'p' });
    const b = new FakeChatModel({ name: 'b', provider: 'p' });
    const result = await route([a, b], (m) => m.chat(msgs));
    expect(result.model).toBe('a');
    expect(b.calls).toHaveLength(0); // b never tried
  });

  it('falls back past a retryable failure', async () => {
    const down = new FakeChatModel({
      name: 'down',
      provider: 'p',
      always: new ModelUnavailableError('p', 'down'),
    });
    const up = new FakeChatModel({
      name: 'up',
      provider: 'q',
      always: response({ model: 'up' }),
    });
    const result = await route([down, up], (m) => m.chat(msgs));
    expect(result.model).toBe('up');
    expect(down.calls).toHaveLength(1);
  });

  it('stops on a non-retryable failure and rethrows it', async () => {
    const bad = new FakeChatModel({
      name: 'bad',
      provider: 'p',
      always: new InvalidRequestError('p', 'malformed'),
    });
    const good = new FakeChatModel({ name: 'good', provider: 'q' });
    await expect(route([bad, good], (m) => m.chat(msgs))).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(good.calls).toHaveLength(0); // never reached
  });

  it('throws AllFailedError when every candidate fails retryably', async () => {
    const a = new FakeChatModel({
      name: 'a',
      provider: 'p',
      always: new RateLimitedError('p'),
    });
    const b = new FakeChatModel({
      name: 'b',
      provider: 'q',
      always: new RateLimitedError('q'),
    });
    const err = await route([a, b], (m) => m.chat(msgs)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllFailedError);
    expect((err as AllFailedError).attempts.map((x) => x.model)).toEqual(['a', 'b']);
    expect((err as AllFailedError).cause).toBeInstanceOf(RateLimitedError);
  });

  it('rethrows a non-ModelError as definitive', async () => {
    const a = new FakeChatModel({
      name: 'a',
      provider: 'p',
      always: new TypeError('bug'),
    });
    const b = new FakeChatModel({ name: 'b', provider: 'q' });
    await expect(route([a, b], (m) => m.chat(msgs))).rejects.toBeInstanceOf(TypeError);
    expect(b.calls).toHaveLength(0);
  });

  it('reports each attempt via onAttempt', async () => {
    const a = new FakeChatModel({
      name: 'a',
      provider: 'p',
      always: new RateLimitedError('p'),
    });
    const b = new FakeChatModel({ name: 'b', provider: 'q' });
    const seen: RouteAttempt[] = [];
    await route([a, b], (m) => m.chat(msgs), { onAttempt: (x) => seen.push(x) });
    expect(seen.map((x) => x.model)).toEqual(['a']);
  });

  it('honours an aborted signal', async () => {
    const a = new FakeChatModel({ name: 'a', provider: 'p' });
    await expect(
      route([a], (m) => m.chat(msgs), { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(a.calls).toHaveLength(0);
  });
});

describe('RoutingChatModel', () => {
  const build = (): { model: RoutingChatModel; a: FakeChatModel; b: FakeChatModel } => {
    const a = new FakeChatModel({
      name: 'a',
      provider: 'openai',
      always: new RateLimitedError('openai'),
    });
    const b = new FakeChatModel({
      name: 'b',
      provider: 'anthropic',
      always: response({ model: 'b' }),
    });
    const registry = new ModelRegistry().register(a).register(b);
    return { model: new RoutingChatModel(registry), a, b };
  };

  it('routes chat with fallback', async () => {
    const { model, a, b } = build();
    const result = await model.chat(msgs);
    expect(result.model).toBe('b');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('exposes synthetic info reflecting registered capabilities', () => {
    const { model } = build();
    expect(model.info).toMatchObject({
      name: 'router',
      provider: 'router',
      supports: { chat: true, tools: true },
    });
  });

  it('reports no tool capability when no tool model is registered', () => {
    const registry = new ModelRegistry().register(
      chatOnly({ name: 'c', provider: 'ollama' }),
    );
    expect(new RoutingChatModel(registry).info.supports.tools).toBe(false);
  });

  it('chatWithTools only routes to tool-capable models', async () => {
    const chatModel = chatOnly({ name: 'chat', provider: 'ollama' });
    const toolModel = new FakeChatModel({
      name: 'tool',
      provider: 'openai',
      always: response({ model: 'tool' }),
    });
    const registry = new ModelRegistry().register(chatModel).register(toolModel);
    const result = await new RoutingChatModel(registry).chatWithTools(msgs, []);
    expect(result.model).toBe('tool');
  });

  it('a per-call route override pins the candidates', async () => {
    const { model, a } = build();
    // Pin to only 'b' — 'a' (which would rate-limit) is not even tried.
    const result = await model.chat(msgs, { extra: { route: { models: ['b'] } } });
    expect(result.model).toBe('b');
    expect(a.calls).toHaveLength(0);
  });

  it('applies default criteria', async () => {
    const a = new FakeChatModel({ name: 'a', provider: 'openai' });
    const b = new FakeChatModel({ name: 'b', provider: 'anthropic' });
    const registry = new ModelRegistry().register(a).register(b);
    const model = new RoutingChatModel(registry, {
      criteria: { provider: 'anthropic' },
    });
    const result = await model.chat(msgs);
    expect(result.model).toBe('b');
    expect(a.calls).toHaveLength(0);
  });

  it('throws NoCandidatesError when nothing matches', async () => {
    const registry = new ModelRegistry().register(
      chatOnly({ name: 'c', provider: 'ollama' }),
    );
    await expect(
      new RoutingChatModel(registry).chatWithTools(msgs, []),
    ).rejects.toBeInstanceOf(NoCandidatesError);
  });

  it('forwards a signal to the chain', async () => {
    const { model } = build();
    await expect(model.chat(msgs, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
