/**
 * The schema DSL — one declaration, two consumers.
 *
 * ## The problem it exists to make impossible
 *
 * A tool's arguments are described **twice** in every agent system: once as JSON
 * Schema, so a model knows what to send, and once as a runtime check, so the tool
 * is not handed nonsense. When those two are separate declarations they drift,
 * and the failure is quiet and awful — the model is told `{ path, recursive }`,
 * the tool enforces `{ path, deep }`, and every call fails with a validation
 * error the model cannot learn from because it was told something else.
 *
 * A {@link ToolSchema} is both. It `extends` the kernel's `Validator`, so it
 * drops straight into `Tool.input` and the kernel parses with it; and it carries
 * `jsonSchema`, which is what a model is told. **They cannot disagree, because
 * they are the same object.**
 *
 * ## Why not Zod
 *
 * Zod is better than this at being Zod. It is rejected for three reasons, and the
 * third is the one that decides it.
 *
 * 1. It is a dependency for the entire tool layer, and the kernel deliberately
 *    took none — it defined `Validator` as a one-method structural interface
 *    *precisely* so that no library is required (kernel `tool.ts`).
 * 2. JSON Schema needs a *second* dependency (`zod-to-json-schema`), which tracks
 *    Zod's releases and supports a subset of it.
 * 3. That subset is the drift, reintroduced. A Zod refinement that the converter
 *    cannot express becomes a rule the tool enforces and the model was never told
 *    about — which is exactly the failure this file exists to prevent, one layer
 *    further down where it is harder to see.
 *
 * **A host that wants Zod can still use it.** `Tool.input` is `Validator`, and
 * `z.object({...})` satisfies `Validator` structurally. They simply supply
 * `parameters` themselves, or their tool tells models nothing about its
 * arguments. That door stays open on purpose; this DSL is the paved path, not a
 * wall.
 *
 * ## What it deliberately cannot express
 *
 * No unions, no intersections, no recursion, no refinements, no transforms. A
 * tool's arguments come from a *model*, and every one of those makes the JSON
 * Schema harder for a model to satisfy and the error harder for it to learn
 * from. The vocabulary here is the vocabulary a model reliably gets right. See
 * RFC-0006 §7.1.
 */

import { SchemaError } from './errors.js';

/** A JSON Schema document. Opaque: nothing here interprets it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * A validator that can also describe itself.
 *
 * `extends Validator<T>` is the load-bearing word. The kernel's `Tool.input` is a
 * `Validator`, so a `ToolSchema` *is* one and needs no adapter; and `jsonSchema`
 * is what {@link describe} hands a model. One declaration, both jobs.
 */
export interface ToolSchema<T> {
  /** The kernel's contract. Throws on bad input; returns `T` on good. */
  parse(input: unknown): T;
  /** What a model is told. The same declaration, rendered. */
  readonly jsonSchema: JsonSchema;
  /** Whether this field may be omitted. Read by {@link object} to build `required`. */
  readonly optional: boolean;
}

/** The type a schema parses to. `Infer<typeof s>` in a tool's generics. */
export type Infer<S> = S extends ToolSchema<infer T> ? T : never;

/** Build a schema from its two halves. Not exported: every factory below uses it. */
function schema<T>(
  jsonSchema: JsonSchema,
  parse: (input: unknown, path: string) => T,
  optional = false,
): ToolSchema<T> {
  return {
    jsonSchema,
    optional,
    // The public entry point starts the path at the root. Every nested parse
    // threads a path down, which is the difference between "expected a string"
    // and "expected a string at files.0.path" — and a model can only fix the
    // second.
    parse: (input: unknown): T => parse(input, ''),
  };
}

export interface StringOptions {
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A regex the value must match. Rendered into JSON Schema as `pattern`. */
  readonly pattern?: RegExp;
  /** Hint for a model: `uri`, `date-time`, `email`. Not enforced. */
  readonly format?: string;
}

export function string(options: StringOptions = {}): ToolSchema<string> {
  return schema<string>(
    {
      type: 'string',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
      // `.source`, not `String(regex)`: the latter includes the slashes and flags,
      // which is not what JSON Schema's `pattern` expects and which every
      // validator on the model's side would reject.
      ...(options.pattern === undefined ? {} : { pattern: options.pattern.source }),
      ...(options.format === undefined ? {} : { format: options.format }),
    },
    (input, path) => {
      if (typeof input !== 'string') {
        throw new SchemaError(path, `must be a string, not ${typeOf(input)}`);
      }
      if (options.minLength !== undefined && input.length < options.minLength) {
        throw new SchemaError(
          path,
          `must be at least ${String(options.minLength)} character(s)`,
        );
      }
      if (options.maxLength !== undefined && input.length > options.maxLength) {
        throw new SchemaError(
          path,
          `must be at most ${String(options.maxLength)} character(s)`,
        );
      }
      if (options.pattern && !options.pattern.test(input)) {
        throw new SchemaError(path, `must match ${String(options.pattern)}`);
      }
      return input;
    },
  );
}

export interface NumberOptions {
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  /** Reject a non-integer. Rendered as `type: 'integer'`. */
  readonly integer?: boolean;
}

export function number(options: NumberOptions = {}): ToolSchema<number> {
  return schema<number>(
    {
      type: options.integer === true ? 'integer' : 'number',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
      ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
    },
    (input, path) => {
      if (typeof input !== 'number' || Number.isNaN(input)) {
        throw new SchemaError(path, `must be a number, not ${typeOf(input)}`);
      }
      // Rejected explicitly rather than left to `typeof`: Infinity is a number
      // and does not survive `JSON.stringify` — it becomes `null`. A tool that
      // accepted it would produce a result that cannot be checkpointed
      // (RFC-0004 §7.6), which is a failure far from here.
      if (!Number.isFinite(input)) {
        throw new SchemaError(path, `must be finite, not ${String(input)}`);
      }
      if (options.integer === true && !Number.isInteger(input)) {
        throw new SchemaError(path, `must be a whole number`);
      }
      if (options.minimum !== undefined && input < options.minimum) {
        throw new SchemaError(path, `must be at least ${String(options.minimum)}`);
      }
      if (options.maximum !== undefined && input > options.maximum) {
        throw new SchemaError(path, `must be at most ${String(options.maximum)}`);
      }
      return input;
    },
  );
}

export function boolean(
  options: { readonly description?: string } = {},
): ToolSchema<boolean> {
  return schema<boolean>(
    {
      type: 'boolean',
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    (input, path) => {
      // Not coerced from `'true'`. A model that sent a string got the schema
      // wrong, and quietly accepting it teaches it that the schema is optional —
      // so the next call sends a string for something that is not a boolean.
      if (typeof input !== 'boolean') {
        throw new SchemaError(path, `must be a boolean, not ${typeOf(input)}`);
      }
      return input;
    },
  );
}

/**
 * One of a fixed set of strings.
 *
 * The single most useful schema for a model-facing tool: it turns "which mode?"
 * from a guess into a list, and JSON Schema's `enum` is the one constraint every
 * provider's structured-output mode honours.
 */
export function enumOf<const T extends readonly [string, ...string[]]>(
  values: T,
  options: { readonly description?: string } = {},
): ToolSchema<T[number]> {
  return schema<T[number]>(
    {
      type: 'string',
      enum: [...values],
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    (input, path) => {
      if (typeof input !== 'string' || !values.includes(input)) {
        throw new SchemaError(path, `must be one of: ${values.join(', ')}`);
      }
      return input;
    },
  );
}

export interface ArrayOptions {
  readonly description?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export function array<T>(
  items: ToolSchema<T>,
  options: ArrayOptions = {},
): ToolSchema<T[]> {
  return schema<T[]>(
    {
      type: 'array',
      items: items.jsonSchema,
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
      ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
      ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
    },
    (input, path) => {
      if (!Array.isArray(input)) {
        throw new SchemaError(path, `must be an array, not ${typeOf(input)}`);
      }
      if (options.minItems !== undefined && input.length < options.minItems) {
        throw new SchemaError(
          path,
          `must have at least ${String(options.minItems)} item(s)`,
        );
      }
      if (options.maxItems !== undefined && input.length > options.maxItems) {
        throw new SchemaError(
          path,
          `must have at most ${String(options.maxItems)} item(s)`,
        );
      }
      return input.map((item, index) =>
        parseInto(items, item, join(path, String(index))),
      );
    },
  );
}

/** The shape of an object schema's fields. */
export type Shape = Readonly<Record<string, ToolSchema<unknown>>>;

/** What a shape parses to, with optional fields optional. */
export type InferShape<S extends Shape> = {
  -readonly [K in keyof S]: Infer<S[K]>;
};

export interface ObjectOptions {
  readonly description?: string;
  /**
   * Keep keys the shape does not declare. Default false — they are dropped.
   *
   * Dropping rather than rejecting is deliberate. A model that adds a stray key
   * has made a small mistake, and failing the whole call over it wastes a turn to
   * teach it nothing it could not have been told by the schema. Dropping is also
   * a *security* property: it is what stops an argument the tool never declared
   * from reaching it, which is the shape of most parameter-injection bugs. A tool
   * that genuinely wants a free-form bag asks for one.
   */
  readonly passthrough?: boolean;
}

export function object<S extends Shape>(
  shape: S,
  options: ObjectOptions = {},
): ToolSchema<InferShape<S>> {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    properties[key] = field.jsonSchema;
    if (!field.optional) required.push(key);
  }

  return schema<InferShape<S>>(
    {
      type: 'object',
      properties,
      // Omitted when empty rather than `required: []`. An empty array is legal
      // JSON Schema and some providers render it into a prompt as a heading with
      // nothing under it, which reads as a bug to the model.
      ...(required.length === 0 ? {} : { required }),
      // Told to the model as well as enforced. A model that knows extra keys are
      // rejected stops sending them; one that is silently ignored keeps trying.
      ...(options.passthrough === true ? {} : { additionalProperties: false }),
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    (input, path) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new SchemaError(path, `must be an object, not ${typeOf(input)}`);
      }
      const raw = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};

      for (const [key, field] of Object.entries(shape)) {
        // `in`, not a truthiness check: a field legitimately sent as `null`,
        // `false`, `0` or `''` is present, and treating it as absent would make
        // an optional field's default silently override a real value.
        if (!(key in raw) && !field.optional) {
          throw new SchemaError(join(path, key), `is required`);
        }

        // An absent optional field is parsed as `undefined` rather than skipped,
        // and the difference is the whole of `withDefault`. Skipping would mean
        // the field never runs, so its default never applies — which made
        // `withDefault` silently useless inside the only construct that uses it.
        // Letting the field decide keeps that knowledge in one place: `optional`
        // answers `undefined`, `withDefault` answers its value, and `object` need
        // not know which it is holding.
        const value = parseInto(field, raw[key], join(path, key));
        // An optional field explicitly sent as `undefined` is omitted rather than
        // written as `undefined`, so the parsed object round-trips through
        // `JSON.stringify` unchanged — which a checkpoint depends on.
        if (value !== undefined) out[key] = value;
      }

      if (options.passthrough === true) {
        for (const [key, value] of Object.entries(raw)) {
          if (!(key in shape)) out[key] = value;
        }
      }

      return out as InferShape<S>;
    },
  );
}

/**
 * A field that may be omitted.
 *
 * Wraps rather than flagging, so `optional` is a property of the *schema* and
 * {@link object} can read it off the shape without a parallel `required: [...]`
 * list that someone has to keep in step.
 */
export function optional<T>(inner: ToolSchema<T>): ToolSchema<T | undefined> {
  return schema<T | undefined>(
    inner.jsonSchema,
    (input, path) => (input === undefined ? undefined : parseInto(inner, input, path)),
    true,
  );
}

/**
 * A field that may be omitted, and has a value when it is.
 *
 * The default is applied on parse **and** advertised in the JSON Schema, because
 * a model that can see the default stops sending the value that equals it — which
 * is tokens saved on every call, and one less thing to get wrong.
 */
export function withDefault<T>(inner: ToolSchema<T>, value: T): ToolSchema<T> {
  return schema<T>(
    { ...inner.jsonSchema, default: value },
    (input, path) => (input === undefined ? value : parseInto(inner, input, path)),
    true,
  );
}

/**
 * Anything at all.
 *
 * An escape hatch, and it is honest about what it costs: a model told `{}` knows
 * nothing about what to send. For a tool whose argument genuinely is arbitrary
 * JSON — a payload to forward, a filter to pass through — it is right. For
 * anything else it is a schema nobody wrote yet.
 */
export function unknown(
  options: { readonly description?: string } = {},
): ToolSchema<unknown> {
  return schema<unknown>(
    {
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    },
    (input) => input,
  );
}

/**
 * A tool that takes nothing.
 *
 * Explicit rather than leaving `input` undefined, and the difference matters at
 * the model: `{ type: 'object', properties: {} }` says "call this with no
 * arguments", while no schema at all says "we did not tell you". The first is a
 * fact the model can act on.
 */
export function nothing(): ToolSchema<Record<string, never>> {
  return schema<Record<string, never>>(
    { type: 'object', properties: {}, additionalProperties: false },
    (input, path) => {
      if (input === undefined || input === null) return {};
      if (typeof input !== 'object' || Array.isArray(input)) {
        throw new SchemaError(path, `must be an object or omitted`);
      }
      return {};
    },
  );
}

/** Run a nested schema, threading the path so the error can name the field. */
function parseInto<T>(field: ToolSchema<T>, value: unknown, path: string): T {
  // Every schema this module builds closes over a path-aware parser, and the
  // public `parse` discards the path. Rather than widen the public interface with
  // an internal second argument — which every hand-written `Validator` would then
  // have to implement — the path is rebuilt onto the message here.
  try {
    return field.parse(value);
  } catch (thrown) {
    if (thrown instanceof SchemaError) throw thrown.at(path);
    throw thrown;
  }
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * What a value is, for an error message a model can act on.
 *
 * Shows the *value* for the common cases — "must be a string, not 42" tells a
 * model it sent a number and lets it see which one. It falls back to the kind
 * only for the three types where the value is useless or unsafe to render: a
 * symbol throws under `String`, a function stringifies to its entire source, and
 * a bigint's literal adds nothing a model can use.
 */
function typeOf(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'an array';
  if (typeof input === 'object') return 'an object';
  if (typeof input === 'string') return 'a string';
  if (typeof input === 'number' || typeof input === 'boolean' || input === undefined) {
    return String(input);
  }
  // bigint, symbol, function — named by kind, never rendered.
  return typeof input;
}
