/**
 * The schema DSL.
 *
 * Two properties matter more than any individual constraint, and both are about
 * the *pair* rather than either half:
 *
 * 1. **The validator and the JSON Schema are the same declaration**, so they
 *    cannot drift. Nearly every test below asserts on both.
 * 2. **An error names the field.** A model's next turn is a rewrite of the
 *    argument this one rejected, and it can only rewrite toward a message that
 *    says where the problem was.
 */

import { describe, expect, it } from 'vitest';
import * as s from '../src/schema.js';
import { SchemaError } from '../src/errors.js';

describe('string', () => {
  it('parses a string and describes itself', () => {
    const schema = s.string({ description: 'A path' });

    expect(schema.parse('/etc/hosts')).toBe('/etc/hosts');
    expect(schema.jsonSchema).toEqual({ type: 'string', description: 'A path' });
  });

  it.each([
    ['a number', 42, 'not 42'],
    ['null', null, 'not null'],
    ['an object', {}, 'not an object'],
    ['an array', [], 'not an array'],
  ])('rejects %s, and says what it got', (_label, input, expected) => {
    expect(() => s.string().parse(input)).toThrow(SchemaError);
    expect(() => s.string().parse(input)).toThrow(`must be a string, ${expected}`);
  });

  it('enforces minLength, and tells the model about it', () => {
    const schema = s.string({ minLength: 3 });

    expect(() => schema.parse('ab')).toThrow('at least 3 character');
    expect(schema.jsonSchema).toMatchObject({ minLength: 3 });
    expect(schema.parse('abc')).toBe('abc');
  });

  it('enforces maxLength, and tells the model about it', () => {
    const schema = s.string({ maxLength: 2 });

    expect(() => schema.parse('abc')).toThrow('at most 2 character');
    expect(schema.jsonSchema).toMatchObject({ maxLength: 2 });
  });

  // `String(/^a/)` is '/^a/', which JSON Schema's `pattern` does not accept —
  // every validator on the model's side would reject the schema itself.
  it('renders a pattern as its source, not with the slashes', () => {
    const schema = s.string({ pattern: /^\/[a-z]+$/i });

    expect(schema.jsonSchema).toMatchObject({ pattern: '^\\/[a-z]+$' });
    expect(schema.parse('/etc')).toBe('/etc');
    expect(() => schema.parse('etc')).toThrow('must match');
  });

  it('carries a format hint without enforcing it', () => {
    const schema = s.string({ format: 'uri' });

    expect(schema.jsonSchema).toMatchObject({ format: 'uri' });
    // Not enforced: `format` is advisory in JSON Schema, and a validator that
    // enforced it would reject values the model was told were fine.
    expect(schema.parse('not a uri')).toBe('not a uri');
  });

  it('is required by default', () => {
    expect(s.string().optional).toBe(false);
  });
});

describe('number', () => {
  it('parses a number and describes itself', () => {
    expect(s.number().parse(1.5)).toBe(1.5);
    expect(s.number().jsonSchema).toEqual({ type: 'number' });
  });

  it.each([
    ['a string', '42'],
    ['null', null],
    ['NaN', Number.NaN],
  ])('rejects %s', (_label, input) => {
    expect(() => s.number().parse(input)).toThrow(SchemaError);
  });

  // Infinity is a number and becomes `null` under JSON.stringify. A tool that
  // accepted it would produce a result that cannot be checkpointed
  // (RFC-0004 §7.6) — a failure a long way from here.
  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s, which JSON cannot carry', (_label, input) => {
    expect(() => s.number().parse(input)).toThrow('must be finite');
  });

  it('enforces integer, and says so in the schema type', () => {
    const schema = s.number({ integer: true });

    expect(schema.jsonSchema).toMatchObject({ type: 'integer' });
    expect(schema.parse(3)).toBe(3);
    expect(() => schema.parse(3.5)).toThrow('whole number');
  });

  it('enforces bounds, and tells the model about them', () => {
    const schema = s.number({ minimum: 1, maximum: 10 });

    expect(schema.jsonSchema).toMatchObject({ minimum: 1, maximum: 10 });
    expect(() => schema.parse(0)).toThrow('at least 1');
    expect(() => schema.parse(11)).toThrow('at most 10');
    expect(schema.parse(5)).toBe(5);
  });
});

describe('boolean', () => {
  it('parses a boolean', () => {
    expect(s.boolean().parse(true)).toBe(true);
    expect(s.boolean().parse(false)).toBe(false);
    expect(s.boolean().jsonSchema).toEqual({ type: 'boolean' });
  });

  // Quietly accepting `'true'` teaches the model the schema is optional, so the
  // next call sends a string for something that is not a boolean.
  it.each([
    ['the string "true"', 'true'],
    ['1', 1],
    ['null', null],
  ])('rejects %s rather than coercing it', (_label, input) => {
    expect(() => s.boolean().parse(input)).toThrow('must be a boolean');
  });
});

describe('enumOf', () => {
  it('parses a member and lists the alternatives', () => {
    const schema = s.enumOf(['read', 'write']);

    expect(schema.parse('read')).toBe('read');
    expect(schema.jsonSchema).toEqual({ type: 'string', enum: ['read', 'write'] });
  });

  it('names every option when it rejects, so the model can pick one', () => {
    expect(() => s.enumOf(['read', 'write']).parse('delete')).toThrow(
      'must be one of: read, write',
    );
  });

  it('rejects a non-string', () => {
    expect(() => s.enumOf(['a']).parse(1)).toThrow('must be one of');
  });
});

describe('array', () => {
  it('parses items with the inner schema and nests the JSON Schema', () => {
    const schema = s.array(s.string());

    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(schema.jsonSchema).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('rejects a non-array', () => {
    expect(() => s.array(s.string()).parse('a')).toThrow('must be an array');
  });

  // The error the model can act on. "must be a string" tells it nothing about
  // which of five items to fix.
  it('names the failing index', () => {
    expect(() => s.array(s.string()).parse(['a', 2, 'c'])).toThrow(
      '"1" must be a string',
    );
  });

  it('enforces item counts, and tells the model about them', () => {
    const schema = s.array(s.string(), { minItems: 1, maxItems: 2 });

    expect(schema.jsonSchema).toMatchObject({ minItems: 1, maxItems: 2 });
    expect(() => schema.parse([])).toThrow('at least 1 item');
    expect(() => schema.parse(['a', 'b', 'c'])).toThrow('at most 2 item');
  });
});

describe('object', () => {
  const schema = s.object({
    path: s.string(),
    recursive: s.optional(s.boolean()),
  });

  it('parses a well-formed object', () => {
    expect(schema.parse({ path: '/tmp', recursive: true })).toEqual({
      path: '/tmp',
      recursive: true,
    });
  });

  it('builds `required` from the fields that are not optional', () => {
    expect(schema.jsonSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
      additionalProperties: false,
    });
  });

  it('names a missing required field', () => {
    expect(() => schema.parse({})).toThrow('"path" is required');
  });

  it('allows an optional field to be absent', () => {
    expect(schema.parse({ path: '/tmp' })).toEqual({ path: '/tmp' });
  });

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, input) => {
    expect(() => schema.parse(input)).toThrow('must be an object');
  });

  // Dropping rather than rejecting: a model that adds a stray key made a small
  // mistake, and failing the call teaches it nothing the schema had not said. It
  // is also what stops an undeclared argument reaching the tool.
  it('drops keys the shape does not declare', () => {
    expect(schema.parse({ path: '/tmp', sudo: true })).toEqual({ path: '/tmp' });
  });

  it('tells the model that extra keys are not accepted', () => {
    // A model that knows stops sending them; one silently ignored keeps trying.
    expect(schema.jsonSchema).toMatchObject({ additionalProperties: false });
  });

  it('keeps extra keys when asked, for a genuine free-form bag', () => {
    const loose = s.object({ id: s.string() }, { passthrough: true });

    expect(loose.parse({ id: 'a', extra: 1 })).toEqual({ id: 'a', extra: 1 });
    expect(loose.jsonSchema).not.toHaveProperty('additionalProperties');
  });

  // An empty `required: []` is legal and some providers render it into a prompt
  // as a heading with nothing under it, which reads to the model as a bug.
  it('omits `required` entirely when nothing is required', () => {
    expect(s.object({ a: s.optional(s.string()) }).jsonSchema).not.toHaveProperty(
      'required',
    );
  });

  // A field sent as `null`, `false`, `0` or `''` is *present*. Treating it as
  // absent would let a default silently override a real value.
  it.each([
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
  ])('treats a field sent as %s as present', (_label, value) => {
    const withUnknown = s.object({ v: s.unknown() });

    expect(withUnknown.parse({ v: value })).toEqual({ v: value });
  });

  it('names a nested field, at any depth', () => {
    const nested = s.object({ files: s.array(s.object({ path: s.string() })) });

    expect(() => nested.parse({ files: [{ path: '/a' }, { path: 2 }] })).toThrow(
      '"files.1.path" must be a string',
    );
  });
});

describe('optional', () => {
  it('accepts undefined and still validates a present value', () => {
    const schema = s.optional(s.string());

    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('a')).toBe('a');
    expect(() => schema.parse(1)).toThrow('must be a string');
  });

  it('is marked optional, which is what object() reads', () => {
    expect(s.optional(s.string()).optional).toBe(true);
  });

  it('describes itself as the inner schema does', () => {
    expect(s.optional(s.string()).jsonSchema).toEqual({ type: 'string' });
  });

  // The parsed object must round-trip through JSON.stringify unchanged, which a
  // checkpoint depends on (RFC-0004 §7.6).
  it('omits an explicitly-undefined field rather than writing undefined', () => {
    const schema = s.object({ a: s.string(), b: s.optional(s.string()) });

    const parsed = schema.parse({ a: 'x', b: undefined });

    expect(Object.keys(parsed)).toEqual(['a']);
  });
});

describe('withDefault', () => {
  it('supplies the value when the field is absent', () => {
    expect(s.withDefault(s.number(), 10).parse(undefined)).toBe(10);
  });

  it('validates a value that was supplied', () => {
    const schema = s.withDefault(s.number(), 10);

    expect(schema.parse(3)).toBe(3);
    expect(() => schema.parse('3')).toThrow('must be a number');
  });

  // A model that can see the default stops sending the value that equals it —
  // tokens saved on every call, and one less thing to get wrong.
  it('advertises the default to the model', () => {
    expect(s.withDefault(s.number(), 10).jsonSchema).toEqual({
      type: 'number',
      default: 10,
    });
  });

  it('is optional, so object() does not require it', () => {
    const schema = s.object({ limit: s.withDefault(s.number(), 10) });

    expect(schema.jsonSchema).not.toHaveProperty('required');
    expect(schema.parse({})).toEqual({ limit: 10 });
  });
});

describe('unknown', () => {
  it('accepts anything', () => {
    expect(s.unknown().parse({ any: 'thing' })).toEqual({ any: 'thing' });
    expect(s.unknown().parse(null)).toBeNull();
  });

  it('describes nothing, which is the honest cost', () => {
    expect(s.unknown().jsonSchema).toEqual({});
    expect(s.unknown({ description: 'A payload' }).jsonSchema).toEqual({
      description: 'A payload',
    });
  });
});

describe('nothing', () => {
  // "Call this with no arguments" is a fact the model can act on; "we did not
  // tell you" is not.
  it('describes a tool that takes no arguments', () => {
    expect(s.nothing().jsonSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it.each([
    ['an empty object', {}],
    ['undefined', undefined],
    ['null', null],
  ])('accepts %s and yields an empty object', (_label, input) => {
    expect(s.nothing().parse(input)).toEqual({});
  });

  it('discards anything it was given anyway', () => {
    expect(s.nothing().parse({ surprise: true })).toEqual({});
  });

  it('rejects a non-object', () => {
    expect(() => s.nothing().parse('x')).toThrow('must be an object or omitted');
  });
});

describe('SchemaError', () => {
  it('reports the root as `input` rather than an empty name', () => {
    expect(new SchemaError('', 'must be a string').message).toBe(
      'input must be a string',
    );
  });

  it('quotes a path', () => {
    expect(new SchemaError('a.b', 'is required').message).toBe('"a.b" is required');
  });

  // A nested schema does not know where it sits; `at` is how the parent tells it.
  it('prefixes a path without mutating the original', () => {
    const original = new SchemaError('path', 'must be a string');

    const nested = original.at('files.0');

    expect(nested.path).toBe('files.0.path');
    expect(nested.message).toBe('"files.0.path" must be a string');
    expect(original.path).toBe('path');
  });

  it('handles a root error being nested', () => {
    expect(new SchemaError('', 'must be a string').at('files.0').path).toBe('files.0');
  });

  it('carries the stable code every layer branches on', () => {
    expect(new SchemaError('a', 'b').code).toBe('SCHEMA_INVALID');
  });
});
