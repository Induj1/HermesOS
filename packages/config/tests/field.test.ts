/**
 * Fields — parsing, the missing-value behaviours, and immutable modifiers.
 */

import { describe, expect, it } from 'vitest';
import {
  boolean,
  integer,
  list,
  number,
  oneOf,
  port,
  string,
  url,
} from '../src/field.js';

describe('parsing', () => {
  it('string takes the value verbatim', () => {
    expect(string().resolve('hello')).toEqual({ ok: true, value: 'hello' });
  });

  it('number accepts integers and decimals, rejects non-numbers', () => {
    expect(number().resolve('3.5')).toEqual({ ok: true, value: 3.5 });
    expect(number().resolve('-2')).toEqual({ ok: true, value: -2 });
    const bad = number().resolve('abc');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/expected a number/);
  });

  it('number rejects non-finite input', () => {
    expect(number().resolve('Infinity').ok).toBe(false);
  });

  it('integer rejects decimals', () => {
    expect(integer().resolve('4')).toEqual({ ok: true, value: 4 });
    expect(integer().resolve('4.2').ok).toBe(false);
  });

  it('port accepts 1..65535 and rejects outside', () => {
    expect(port().resolve('8080')).toEqual({ ok: true, value: 8080 });
    expect(port().resolve('0').ok).toBe(false);
    expect(port().resolve('70000').ok).toBe(false);
    expect(port().resolve('80.5').ok).toBe(false);
  });

  it('boolean accepts the documented spellings, any case', () => {
    for (const raw of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(boolean().resolve(raw)).toEqual({ ok: true, value: true });
    }
    for (const raw of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(boolean().resolve(raw)).toEqual({ ok: true, value: false });
    }
    expect(boolean().resolve('maybe').ok).toBe(false);
  });

  it('url accepts a valid URL and rejects garbage', () => {
    expect(url().resolve('https://example.com/x')).toEqual({
      ok: true,
      value: 'https://example.com/x',
    });
    expect(url().resolve('not a url').ok).toBe(false);
  });

  it('oneOf accepts a member and rejects a non-member', () => {
    const level = oneOf(['debug', 'info', 'warn']);
    expect(level.resolve('info')).toEqual({ ok: true, value: 'info' });
    const bad = level.resolve('trace');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/debug, info, warn/);
  });

  it('list splits on commas, trims, and drops empties', () => {
    expect(list().resolve('a, b ,,c')).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  });
});

describe('missing-value behaviour', () => {
  it('required fields error when unset or blank', () => {
    const r = string().resolve(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/required/);
    expect(string().resolve('   ').ok).toBe(false);
  });

  it('optional fields yield undefined when unset', () => {
    expect(string().optional().resolve(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('default fields yield the default when unset', () => {
    expect(port().default(3000).resolve(undefined)).toEqual({ ok: true, value: 3000 });
  });

  it('a set value overrides a default', () => {
    expect(port().default(3000).resolve('9090')).toEqual({ ok: true, value: 9090 });
  });

  it('trims before parsing', () => {
    expect(integer().resolve('  42  ')).toEqual({ ok: true, value: 42 });
  });
});

describe('metadata and immutability', () => {
  it('meta reflects required, default, secret, description, and envVar', () => {
    const f = port().default(3000).secret().describe('the port').from('HTTP_PORT');
    expect(f.meta()).toEqual({
      typeName: 'port',
      envVar: 'HTTP_PORT',
      required: false,
      defaultLabel: '3000',
      secret: true,
      description: 'the port',
    });
  });

  it('a plain required field has no default label and is required', () => {
    const m = string().meta();
    expect(m.required).toBe(true);
    expect(m.defaultLabel).toBeUndefined();
    expect(m.secret).toBe(false);
    expect(m.envVar).toBeUndefined();
  });

  it('list renders its default as a comma-joined label', () => {
    expect(list().default(['a', 'b']).meta().defaultLabel).toBe('a,b');
  });

  it('modifiers return new fields and never mutate the original', () => {
    const base = string();
    const optional = base.optional();
    expect(base.resolve(undefined).ok).toBe(false);
    expect(optional.resolve(undefined).ok).toBe(true);
  });
});
