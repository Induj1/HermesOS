/**
 * A name -> thing map with a no-clobber rule.
 *
 * Tools and agents both need one, and both need the same guarantee: registering
 * a duplicate name throws rather than silently replacing. Two plugins that both
 * define a "search" tool is a conflict the host must resolve explicitly, not a
 * race decided by plugin load order.
 */

import { DuplicateRegistrationError, NotFoundError } from './errors.js';

/** The read side, which is all a consumer of the runtime should need. */
export interface ReadonlyRegistry<T> {
  get(name: string): T | undefined;
  require(name: string): T;
  has(name: string): boolean;
  list(): readonly T[];
  readonly size: number;
}

export class Registry<
  T extends { readonly name: string },
> implements ReadonlyRegistry<T> {
  readonly #items = new Map<string, T>();
  readonly #kind: string;

  /** @param kind Names the contents in error messages, e.g. "tool". */
  constructor(kind: string) {
    this.#kind = kind;
  }

  register(item: T): void {
    if (this.#items.has(item.name)) {
      throw new DuplicateRegistrationError(this.#kind, item.name);
    }
    this.#items.set(item.name, item);
  }

  get(name: string): T | undefined {
    return this.#items.get(name);
  }

  /** Like `get`, but throws {@link NotFoundError} instead of returning undefined. */
  require(name: string): T {
    const item = this.#items.get(name);
    if (!item) throw new NotFoundError(this.#kind, name);
    return item;
  }

  has(name: string): boolean {
    return this.#items.has(name);
  }

  list(): readonly T[] {
    return [...this.#items.values()];
  }

  unregister(name: string): boolean {
    return this.#items.delete(name);
  }

  clear(): void {
    this.#items.clear();
  }

  get size(): number {
    return this.#items.size;
  }
}
