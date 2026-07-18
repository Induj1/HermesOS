/**
 * Fields — the typed, parseable units a configuration schema is built from.
 *
 * A `Field<T>` knows three things: how to parse one raw environment string into
 * a `T`, what to do when the variable is absent (required → error, `default` →
 * a fixed value, `optional` → `undefined`), and enough metadata to document and
 * safely redact itself. Fields are immutable: every modifier (`optional`,
 * `default`, `secret`, …) returns a new field, so a shared schema can never be
 * mutated out from under a caller.
 *
 * Parsing never throws — it returns a `ParseResult`, so `loadConfig` can gather
 * *every* problem in one pass instead of failing on the first bad variable.
 */

/** The outcome of parsing one raw value: a typed value, or a human message. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const err = (message: string): ParseResult<never> => ({ ok: false, message });

/** What a field yields when its variable is not set in the environment. */
type Missing<T> =
  | { readonly kind: 'required' }
  | { readonly kind: 'default'; readonly value: T }
  | { readonly kind: 'undefined' };

/** A field's self-description, for documentation and redaction. */
export interface FieldMeta {
  /** The parser's name, e.g. `string`, `integer`, `boolean`, `enum(a|b)`. */
  readonly typeName: string;
  /** An explicit environment variable name, or `undefined` to derive from the key. */
  readonly envVar: string | undefined;
  /** True when an unset variable is an error (no default, not optional). */
  readonly required: boolean;
  /** A rendered default, or `undefined` when there is none. */
  readonly defaultLabel: string | undefined;
  /** True when the value must never be logged in the clear. */
  readonly secret: boolean;
  /** A one-line human description, or `''`. */
  readonly description: string;
}

interface Opts<T> {
  readonly typeName: string;
  readonly parse: (raw: string) => ParseResult<T>;
  readonly missing: Missing<T>;
  readonly envVar: string | undefined;
  readonly secret: boolean;
  readonly description: string;
}

export class Field<T> {
  readonly #opts: Opts<T>;

  constructor(opts: Opts<T>) {
    this.#opts = opts;
  }

  /** Read this field from an already-looked-up raw value (or `undefined` if unset). */
  resolve(raw: string | undefined): ParseResult<T> {
    // Treat whitespace-only exactly as unset: a variable set to "" or "  " in a
    // shell or a `.env` file is almost always "I did not set this", not "".
    const trimmed = raw?.trim() ?? '';
    if (trimmed === '') {
      const m = this.#opts.missing;
      if (m.kind === 'required') return err('is required but not set');
      if (m.kind === 'default') return ok(m.value);
      return ok(undefined as T);
    }
    return this.#opts.parse(trimmed);
  }

  /** Absent variable yields `undefined` instead of an error. */
  optional(): Field<T | undefined> {
    return new Field<T | undefined>({
      ...this.#opts,
      missing: { kind: 'undefined' },
    });
  }

  /** Absent variable yields `value`; the field is no longer required. */
  default(value: T): Field<T> {
    return new Field<T>({
      ...this.#opts,
      missing: { kind: 'default', value },
    });
  }

  /** Mark the value as sensitive: it is masked by `redactedView` and the docs. */
  secret(): Field<T> {
    return new Field<T>({ ...this.#opts, secret: true });
  }

  /** Attach a one-line human description (shown in the config reference). */
  describe(description: string): Field<T> {
    return new Field<T>({ ...this.#opts, description });
  }

  /** Override the environment variable name (default: derived from the schema key). */
  from(envVar: string): Field<T> {
    return new Field<T>({ ...this.#opts, envVar });
  }

  /** This field's metadata, for documentation and redaction. */
  meta(): FieldMeta {
    const m = this.#opts.missing;
    return {
      typeName: this.#opts.typeName,
      envVar: this.#opts.envVar,
      required: m.kind === 'required',
      // `String` renders arrays comma-joined (`['a','b']` → `a,b`), which is the
      // one non-scalar type a field carries; scalars render as themselves.
      defaultLabel: m.kind === 'default' ? String(m.value) : undefined,
      secret: this.#opts.secret,
      description: this.#opts.description,
    };
  }
}

/** Build a required field from a type name and a parser. */
function field<T>(typeName: string, parse: (raw: string) => ParseResult<T>): Field<T> {
  return new Field<T>({
    typeName,
    parse,
    missing: { kind: 'required' },
    envVar: undefined,
    secret: false,
    description: '',
  });
}

/** A string, taken verbatim (after the shared trim). */
export function string(): Field<string> {
  return field('string', (raw) => ok(raw));
}

/** A finite number (integer or decimal). */
export function number(): Field<number> {
  return field('number', (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? ok(n) : err(`expected a number, got "${raw}"`);
  });
}

/** A finite integer. Rejects decimals and non-numeric input. */
export function integer(): Field<number> {
  return field('integer', (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) return err(`expected an integer, got "${raw}"`);
    return ok(n);
  });
}

/** A TCP port: an integer in 1..65535. */
export function port(): Field<number> {
  return field('port', (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return err(`expected a port in 1..65535, got "${raw}"`);
    }
    return ok(n);
  });
}

/** A boolean. Accepts 1/0, true/false, yes/no, on/off (any case). */
export function boolean(): Field<boolean> {
  const truthy = new Set(['1', 'true', 'yes', 'on']);
  const falsy = new Set(['0', 'false', 'no', 'off']);
  return field('boolean', (raw) => {
    const v = raw.toLowerCase();
    if (truthy.has(v)) return ok(true);
    if (falsy.has(v)) return ok(false);
    return err(`expected a boolean (true/false, 1/0, yes/no, on/off), got "${raw}"`);
  });
}

/** A syntactically valid absolute URL. Stored as the original string. */
export function url(): Field<string> {
  return field('url', (raw) => {
    try {
      // Constructed only to validate the syntax; the value is stored as-is.
      const parsed = new URL(raw);
      void parsed;
      return ok(raw);
    } catch {
      return err(`expected a valid URL, got "${raw}"`);
    }
  });
}

/** One of a fixed set of string values. */
export function oneOf<const V extends readonly [string, ...string[]]>(
  values: V,
): Field<V[number]> {
  return field(`enum(${values.join('|')})`, (raw) =>
    values.includes(raw)
      ? ok(raw as V[number])
      : err(`expected one of ${values.join(', ')}, got "${raw}"`),
  );
}

/** A comma-separated list of trimmed, non-empty strings. */
export function list(): Field<readonly string[]> {
  return field<readonly string[]>('list', (raw) =>
    ok(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  );
}
