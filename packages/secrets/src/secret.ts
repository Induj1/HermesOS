/**
 * `Secret` — an opaque holder for a sensitive string.
 *
 * The value only comes out through the explicit `.expose()` call. Every path by
 * which a value *accidentally* reaches a log, an error message, or a JSON body
 * is overridden to render `[redacted]`: `toString`, template interpolation,
 * `JSON.stringify`, and Node's `util.inspect` (`console.log`). That turns
 * "someone logged the config object and leaked the API key" from a latent
 * incident into a non-event — the leak-resistant default, with a deliberate
 * `.expose()` at the one place the raw value is actually needed (the HTTP
 * `Authorization` header, the database driver).
 */

// The well-known symbol Node's `util.inspect`/`console.log` looks for, referenced
// by name so this package needs no `node:util` import.
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

const REDACTED = '[redacted]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw secret. The one deliberate seam by which the value escapes. */
  expose(): string {
    return this.#value;
  }

  /** True when the wrapped value is empty. */
  get isEmpty(): boolean {
    return this.#value === '';
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret(${REDACTED})`;
  }

  readonly [Symbol.toStringTag] = 'Secret';
}

/** Type guard: is this value a `Secret`? */
export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}
