/**
 * The event bus.
 *
 * This is the kernel's only outbound coupling. Nothing inside calls out to a
 * logger, a database, or a Telegram client; it announces what happened and
 * whoever cares subscribes. That is what lets persistence, metrics, and
 * transports be added later without the kernel learning they exist.
 *
 * Two decisions worth knowing:
 *
 * 1. `emit` awaits its listeners. A slow subscriber therefore slows the emitter.
 *    That is the point: a subscriber writing a task result to disk must be able
 *    to apply backpressure rather than fall silently behind the scheduler.
 *
 * 2. A throwing listener never breaks the emit. Errors are routed to
 *    `onListenerError` and the remaining listeners still run. One bad observer
 *    must not be able to wedge the scheduler.
 */

import { toError } from './errors.js';

/**
 * Event name -> payload type.
 *
 * Constrained to `object` rather than `Record<string, unknown>` so that an
 * `interface` works as well as a type alias. Only aliases get an implicit index
 * signature, so the tighter constraint would reject every interface with an
 * error that does not explain itself — and each key is read through
 * `keyof M & string` anyway, which needs nothing more than this.
 */
export type EventMap = object;

export type Listener<T> = (payload: T) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

export interface EmittedEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface EventBusOptions {
  /** Where listener exceptions go. Defaults to silently dropping them. */
  readonly onListenerError?: (error: Error, event: EmittedEvent) => void;
}

export interface WaitForOptions<T> {
  /** Ignore events that do not match. */
  readonly filter?: (payload: T) => boolean;
  /** Reject when this aborts. */
  readonly signal?: AbortSignal;
}

interface Handler {
  readonly fn: Listener<never>;
  readonly once: boolean;
}

export class EventBus<M extends EventMap> {
  readonly #handlers = new Map<string, Handler[]>();
  #wildcards: Listener<EmittedEvent>[] = [];
  readonly #onListenerError: ((error: Error, event: EmittedEvent) => void) | undefined;

  constructor(options: EventBusOptions = {}) {
    this.#onListenerError = options.onListenerError;
  }

  /** Subscribe to `type` until unsubscribed. */
  on<K extends keyof M & string>(type: K, listener: Listener<M[K]>): Subscription {
    return this.#add(type, listener, false);
  }

  /** Subscribe to the next `type` only. */
  once<K extends keyof M & string>(type: K, listener: Listener<M[K]>): Subscription {
    return this.#add(type, listener, true);
  }

  /**
   * Subscribe to every event. For observability — logging, tracing, a debug
   * console — where enumerating event names would mean editing the observer
   * every time the kernel grows one.
   */
  onAny(listener: Listener<EmittedEvent>): Subscription {
    this.#wildcards.push(listener);
    return {
      unsubscribe: () => {
        this.#wildcards = this.#wildcards.filter((fn) => fn !== listener);
      },
    };
  }

  /** Remove a listener by identity. */
  off<K extends keyof M & string>(type: K, listener: Listener<M[K]>): void {
    const handlers = this.#handlers.get(type);
    if (!handlers) return;
    const remaining = handlers.filter((h) => h.fn !== listener);
    if (remaining.length === 0) this.#handlers.delete(type);
    else this.#handlers.set(type, remaining);
  }

  /**
   * Deliver `payload` to every listener for `type`, in subscription order, then
   * to wildcard listeners. Resolves once they all have.
   */
  async emit<K extends keyof M & string>(type: K, payload: M[K]): Promise<void> {
    const event: EmittedEvent = { type, payload };

    // Snapshot: a listener may subscribe or unsubscribe while we are iterating,
    // and that must not affect the delivery already in flight.
    const handlers = this.#handlers.get(type);
    if (handlers && handlers.length > 0) {
      const snapshot = [...handlers];
      const survivors = handlers.filter((h) => !h.once);
      if (survivors.length === 0) this.#handlers.delete(type);
      else this.#handlers.set(type, survivors);

      for (const handler of snapshot) {
        await this.#invoke(handler.fn as Listener<M[K]>, payload, event);
      }
    }

    for (const wildcard of [...this.#wildcards]) {
      await this.#invoke(wildcard, event, event);
    }
  }

  /**
   * Resolve with the next matching `type`. The subscription is always torn down,
   * including on abort, so a `waitFor` that never fires cannot leak a listener.
   */
  waitFor<K extends keyof M & string>(
    type: K,
    options: WaitForOptions<M[K]> = {},
  ): Promise<M[K]> {
    const { filter, signal } = options;
    return new Promise<M[K]>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error(`Aborted while waiting for "${type}"`));
        return;
      }

      const subscription = this.on(type, (payload) => {
        if (filter && !filter(payload)) return;
        cleanup();
        resolve(payload);
      });

      const onAbort = (): void => {
        cleanup();
        reject(new Error(`Aborted while waiting for "${type}"`));
      };

      const cleanup = (): void => {
        subscription.unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  listenerCount(type: keyof M & string): number {
    return this.#handlers.get(type)?.length ?? 0;
  }

  removeAllListeners(type?: keyof M & string): void {
    if (type === undefined) {
      this.#handlers.clear();
      this.#wildcards = [];
      return;
    }
    this.#handlers.delete(type);
  }

  #add(type: string, fn: Listener<never>, once: boolean): Subscription {
    const handlers = this.#handlers.get(type) ?? [];
    handlers.push({ fn, once });
    this.#handlers.set(type, handlers);

    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        const current = this.#handlers.get(type);
        if (!current) return;
        const index = current.findIndex((h) => h.fn === fn && h.once === once);
        if (index === -1) return;
        current.splice(index, 1);
        if (current.length === 0) this.#handlers.delete(type);
      },
    };
  }

  async #invoke<T>(fn: Listener<T>, payload: T, event: EmittedEvent): Promise<void> {
    try {
      await fn(payload);
    } catch (thrown) {
      this.#onListenerError?.(toError(thrown), event);
    }
  }
}
