/**
 * Time, as an injected capability.
 *
 * The kernel never calls `Date.now()` or `setTimeout` directly. Every timestamp
 * and every delay goes through a Clock, so a test can drive retry backoff and
 * task timeouts instantly and deterministically instead of really sleeping.
 */

import { CancellationError } from './errors.js';

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /**
   * Resolve after `ms`. Rejects with {@link CancellationError} if `signal`
   * aborts first, and never leaves a timer behind.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Real wall-clock time and real timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new CancellationError('Sleep aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new CancellationError('Sleep aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/**
 * A clock that only moves when told to.
 *
 * `advance(ms)` fires every sleep due at or before the new time and yields to
 * the microtask queue, so awaiting it also lets the continuations of those
 * sleeps run.
 */
export class TestClock implements Clock {
  #now: number;
  #waiters: { dueAt: number; resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(startAt = 0) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new CancellationError('Sleep aborted'));
        return;
      }
      const waiter = { dueAt: this.#now + ms, resolve, reject };
      this.#waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          this.#waiters = this.#waiters.filter((w) => w !== waiter);
          reject(new CancellationError('Sleep aborted'));
        },
        { once: true },
      );
    });
  }

  /** Move time forward, firing everything that comes due. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    const due = this.#waiters.filter((w) => w.dueAt <= this.#now);
    this.#waiters = this.#waiters.filter((w) => w.dueAt > this.#now);
    for (const waiter of due) waiter.resolve();
    await Promise.resolve();
  }

  /** How many sleeps are outstanding — a leak detector for tests. */
  get pendingTimers(): number {
    return this.#waiters.length;
  }
}
