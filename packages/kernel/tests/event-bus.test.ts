import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../src/event-bus.js';

interface TestEvents {
  greet: { name: string };
  tick: { n: number };
}

const bus = (
  options?: ConstructorParameters<typeof EventBus<TestEvents>>[0],
): EventBus<TestEvents> => new EventBus<TestEvents>(options);

describe('EventBus', () => {
  it('delivers a payload to a subscriber', async () => {
    const b = bus();
    const seen: string[] = [];
    b.on('greet', ({ name }) => void seen.push(name));

    await b.emit('greet', { name: 'hermes' });

    expect(seen).toEqual(['hermes']);
  });

  it('delivers nothing to subscribers of other events', async () => {
    const b = bus();
    const listener = vi.fn();
    b.on('tick', listener);

    await b.emit('greet', { name: 'hermes' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('calls listeners in subscription order', async () => {
    const b = bus();
    const order: number[] = [];
    b.on('tick', () => void order.push(1));
    b.on('tick', () => void order.push(2));
    b.on('tick', () => void order.push(3));

    await b.emit('tick', { n: 0 });

    expect(order).toEqual([1, 2, 3]);
  });

  it('awaits async listeners before resolving', async () => {
    const b = bus();
    let done = false;
    b.on('tick', async () => {
      await Promise.resolve();
      done = true;
    });

    await b.emit('tick', { n: 1 });

    expect(done).toBe(true);
  });

  it('unsubscribes via the returned subscription', async () => {
    const b = bus();
    const listener = vi.fn();
    const sub = b.on('tick', listener);

    sub.unsubscribe();
    await b.emit('tick', { n: 1 });

    expect(listener).not.toHaveBeenCalled();
    expect(b.listenerCount('tick')).toBe(0);
  });

  it('unsubscribing twice is harmless and does not remove others', async () => {
    const b = bus();
    const first = vi.fn();
    const second = vi.fn();
    const sub = b.on('tick', first);
    b.on('tick', second);

    sub.unsubscribe();
    sub.unsubscribe();
    await b.emit('tick', { n: 1 });

    expect(second).toHaveBeenCalledOnce();
  });

  it('off removes by identity', async () => {
    const b = bus();
    const listener = vi.fn();
    b.on('tick', listener);

    b.off('tick', listener);
    await b.emit('tick', { n: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('once fires exactly once, then unsubscribes', async () => {
    const b = bus();
    const listener = vi.fn();
    b.once('tick', listener);

    await b.emit('tick', { n: 1 });
    await b.emit('tick', { n: 2 });

    expect(listener).toHaveBeenCalledExactlyOnceWith({ n: 1 });
    expect(b.listenerCount('tick')).toBe(0);
  });

  it('onAny observes every event with its type', async () => {
    const b = bus();
    const seen: string[] = [];
    b.onAny((event) => void seen.push(event.type));

    await b.emit('tick', { n: 1 });
    await b.emit('greet', { name: 'x' });

    expect(seen).toEqual(['tick', 'greet']);
  });

  it('isolates a throwing listener: later listeners still run', async () => {
    const onListenerError = vi.fn();
    const b = bus({ onListenerError });
    const after = vi.fn();
    b.on('tick', () => {
      throw new Error('boom');
    });
    b.on('tick', after);

    await expect(b.emit('tick', { n: 1 })).resolves.toBeUndefined();

    expect(after).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(onListenerError.mock.calls[0]?.[0]).toMatchObject({ message: 'boom' });
    expect(onListenerError.mock.calls[0]?.[1]).toMatchObject({ type: 'tick' });
  });

  it('routes a rejected async listener to onListenerError too', async () => {
    const onListenerError = vi.fn();
    const b = bus({ onListenerError });
    b.on('tick', () => Promise.reject(new Error('async boom')));

    await b.emit('tick', { n: 1 });

    expect(onListenerError.mock.calls[0]?.[0]).toMatchObject({ message: 'async boom' });
  });

  it('coerces a non-Error throw into an Error', async () => {
    const onListenerError = vi.fn();
    const b = bus({ onListenerError });
    b.on('tick', () => {
      // Throwing a non-Error is the whole point of this test.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a string';
    });

    await b.emit('tick', { n: 1 });

    expect(onListenerError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('an emit in flight is unaffected by a listener subscribing mid-delivery', async () => {
    const b = bus();
    const late = vi.fn();
    b.on('tick', () => {
      b.on('tick', late);
    });

    await b.emit('tick', { n: 1 });

    // The new listener joins for the *next* emit, not the one already running.
    expect(late).not.toHaveBeenCalled();
    await b.emit('tick', { n: 2 });
    expect(late).toHaveBeenCalledOnce();
  });

  it('waitFor resolves with the next matching payload', async () => {
    const b = bus();
    const pending = b.waitFor('tick');

    await b.emit('tick', { n: 7 });

    await expect(pending).resolves.toEqual({ n: 7 });
    expect(b.listenerCount('tick')).toBe(0);
  });

  it('waitFor ignores events its filter rejects', async () => {
    const b = bus();
    const pending = b.waitFor('tick', { filter: ({ n }) => n > 2 });

    await b.emit('tick', { n: 1 });
    await b.emit('tick', { n: 3 });

    await expect(pending).resolves.toEqual({ n: 3 });
  });

  it('waitFor rejects on abort and leaves no listener behind', async () => {
    const b = bus();
    const controller = new AbortController();
    const pending = b.waitFor('tick', { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted while waiting for "tick"/);
    expect(b.listenerCount('tick')).toBe(0);
  });

  it('waitFor rejects immediately if the signal is already aborted', async () => {
    const b = bus();
    await expect(b.waitFor('tick', { signal: AbortSignal.abort() })).rejects.toThrow(
      /Aborted/,
    );
  });

  it('removeAllListeners clears one event or all of them', async () => {
    const b = bus();
    const wildcard = vi.fn();
    b.on('tick', vi.fn());
    b.on('greet', vi.fn());
    b.onAny(wildcard);

    b.removeAllListeners('tick');
    expect(b.listenerCount('tick')).toBe(0);
    expect(b.listenerCount('greet')).toBe(1);

    b.removeAllListeners();
    expect(b.listenerCount('greet')).toBe(0);
    await b.emit('tick', { n: 1 });
    expect(wildcard).not.toHaveBeenCalled();
  });
});
