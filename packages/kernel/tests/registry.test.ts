import { describe, expect, it } from 'vitest';

import { DuplicateRegistrationError, NotFoundError } from '../src/errors.js';
import { Registry } from '../src/registry.js';

interface Thing {
  readonly name: string;
}

const thing = (name: string): Thing => ({ name });

describe('Registry', () => {
  it('stores and retrieves by name', () => {
    const registry = new Registry<Thing>('tool');
    const item = thing('search');

    registry.register(item);

    expect(registry.get('search')).toBe(item);
    expect(registry.has('search')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('returns undefined for an unknown name', () => {
    expect(new Registry<Thing>('tool').get('nope')).toBeUndefined();
  });

  it('refuses to clobber an existing name', () => {
    const registry = new Registry<Thing>('tool');
    registry.register(thing('search'));

    expect(() => {
      registry.register(thing('search'));
    }).toThrow(DuplicateRegistrationError);
    expect(() => {
      registry.register(thing('search'));
    }).toThrow(/A tool named "search" is already registered/);
  });

  it('require throws a named error rather than returning undefined', () => {
    const registry = new Registry<Thing>('agent');

    expect(() => registry.require('planner')).toThrow(NotFoundError);
    expect(() => registry.require('planner')).toThrow(
      /No agent named "planner" is registered/,
    );
  });

  it('lists everything registered', () => {
    const registry = new Registry<Thing>('tool');
    registry.register(thing('a'));
    registry.register(thing('b'));

    expect(registry.list().map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('unregister frees the name for reuse', () => {
    const registry = new Registry<Thing>('tool');
    registry.register(thing('a'));

    expect(registry.unregister('a')).toBe(true);
    expect(registry.unregister('a')).toBe(false);
    expect(() => {
      registry.register(thing('a'));
    }).not.toThrow();
  });

  it('clear empties it', () => {
    const registry = new Registry<Thing>('tool');
    registry.register(thing('a'));

    registry.clear();

    expect(registry.size).toBe(0);
  });
});
