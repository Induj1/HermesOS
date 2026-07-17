/**
 * Capability catalog behaviour.
 *
 * The subtle claims worth pinning are about *identity*: that a tool and an agent
 * may share a name without shadowing each other (the kernel keeps two registries
 * and allows exactly that), and that a composite resolves conflicts in the
 * direction it documents.
 *
 * The `RuntimeCapabilityCatalog` tests drive a real kernel `Runtime` rather than a
 * stub. The whole point of `CapabilitySource` is that the kernel satisfies it *by
 * coincidence of shape*, and a hand-written stub would satisfy the port while
 * proving nothing about the class the port was extracted for.
 */

import { describe, expect, it } from 'vitest';
import { defineAgent, defineTool, Runtime, sequentialIds } from '@hermes/kernel';
import {
  CompositeCapabilityCatalog,
  RuntimeCapabilityCatalog,
  StaticCapabilityCatalog,
} from '../src/ports/capability-catalog.js';
import type { CapabilitySource } from '../src/ports/capability-catalog.js';
import { capability } from './helpers/fixtures.js';

describe('StaticCapabilityCatalog', () => {
  it('lists what it was given, in order', () => {
    const catalog = new StaticCapabilityCatalog([capability('a'), capability('b')]);

    expect(catalog.list().map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('is empty when given nothing', () => {
    const catalog = new StaticCapabilityCatalog([]);

    expect(catalog.list()).toEqual([]);
    expect(catalog.has('anything')).toBe(false);
    expect(catalog.find('anything')).toBeUndefined();
  });

  it('finds a capability by name', () => {
    const catalog = new StaticCapabilityCatalog([capability('summarise')]);

    expect(catalog.find('summarise')?.name).toBe('summarise');
    expect(catalog.find('absent')).toBeUndefined();
  });

  it('answers has() by name alone when no kind is given', () => {
    const catalog = new StaticCapabilityCatalog([capability('a')]);

    expect(catalog.has('a')).toBe(true);
    expect(catalog.has('b')).toBe(false);
  });

  it('answers has() by kind and name together when a kind is given', () => {
    const catalog = new StaticCapabilityCatalog([capability('a', { kind: 'tool' })]);

    expect(catalog.has('a', 'tool')).toBe(true);
    // A real mistake with a real fix: the name exists, the kind does not.
    expect(catalog.has('a', 'agent')).toBe(false);
  });

  // The kernel's registries are per-kind, so this is a legal configuration.
  // Keying by name alone would let one shadow the other and misroute silently.
  it('keeps a tool and an agent that share a name distinct', () => {
    const catalog = new StaticCapabilityCatalog([
      capability('brief', { kind: 'tool' }),
      capability('brief', { kind: 'agent' }),
    ]);

    expect(catalog.has('brief', 'tool')).toBe(true);
    expect(catalog.has('brief', 'agent')).toBe(true);
    expect(catalog.list()).toHaveLength(2);
  });

  it('does not observe later mutation of the array it was constructed from', () => {
    const source = [capability('a')];
    const catalog = new StaticCapabilityCatalog(source);

    source.push(capability('b'));

    expect(catalog.list().map((c) => c.name)).toEqual(['a']);
  });
});

describe('RuntimeCapabilityCatalog', () => {
  /** A real runtime, with one real tool and one real agent. */
  const runtimeWith = (): Runtime => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fixtures',
      setup(ctx) {
        ctx.registerTool(
          defineTool<unknown, string>({
            name: 'calendar.today',
            description: "Today's events",
            execute: () => Promise.resolve('ok'),
          }),
        );
        ctx.registerAgent(
          defineAgent<unknown, string>({
            name: 'summariser',
            description: 'Summarises things',
            capabilities: ['text', 'summarise'],
            handle: () => Promise.resolve('ok'),
          }),
        );
      },
    });
    return runtime;
  };

  // The Dependency Inversion claim, checked rather than asserted in a comment:
  // the port is declared in the planner's terms and the kernel — which knows
  // nothing about the planner — satisfies it structurally.
  it('adapts a real kernel Runtime without the kernel knowing', async () => {
    const runtime = runtimeWith();
    await runtime.start();
    const catalog = new RuntimeCapabilityCatalog(runtime);

    expect(catalog.has('calendar.today', 'tool')).toBe(true);
    expect(catalog.has('summariser', 'agent')).toBe(true);

    await runtime.stop();
  });

  it('reports a tool as a tool and an agent as an agent', async () => {
    const runtime = runtimeWith();
    await runtime.start();
    const catalog = new RuntimeCapabilityCatalog(runtime);

    expect(catalog.find('calendar.today')).toEqual({
      kind: 'tool',
      name: 'calendar.today',
      description: "Today's events",
      tags: [],
    });
    expect(catalog.has('calendar.today', 'agent')).toBe(false);

    await runtime.stop();
  });

  // The kernel carries `Agent.capabilities` as free-form tags "for routing layers
  // built above it". This is that layer; this is where they land.
  it('surfaces an agent capability tags as the planner tags', async () => {
    const runtime = runtimeWith();
    await runtime.start();

    expect(new RuntimeCapabilityCatalog(runtime).find('summariser')?.tags).toEqual([
      'text',
      'summarise',
    ]);

    await runtime.stop();
  });

  it('gives an agent with no declared tags an empty tag list, never undefined', () => {
    const source: CapabilitySource = {
      tools: { list: () => [] },
      agents: { list: () => [{ name: 'plain', description: 'No tags' }] },
    };

    expect(new RuntimeCapabilityCatalog(source).find('plain')?.tags).toEqual([]);
  });

  // Reading through rather than snapshotting is what lets a catalog be built
  // before start() and still be correct after the plugins have registered.
  it('sees capabilities registered after the catalog was built', async () => {
    const runtime = runtimeWith();
    const catalog = new RuntimeCapabilityCatalog(runtime);

    expect(catalog.has('calendar.today')).toBe(false);
    await runtime.start();
    expect(catalog.has('calendar.today')).toBe(true);

    await runtime.stop();
  });

  it('lists tools before agents, so the order is stable for a prompt', async () => {
    const runtime = runtimeWith();
    await runtime.start();

    expect(new RuntimeCapabilityCatalog(runtime).list().map((c) => c.kind)).toEqual([
      'tool',
      'agent',
    ]);

    await runtime.stop();
  });

  it('is empty for a runtime with no plugins', () => {
    const catalog = new RuntimeCapabilityCatalog(
      Runtime.create({ ids: sequentialIds() }),
    );

    expect(catalog.list()).toEqual([]);
    expect(catalog.find('anything')).toBeUndefined();
  });
});

describe('CompositeCapabilityCatalog', () => {
  it('reads from every catalog it was given', () => {
    const catalog = new CompositeCapabilityCatalog([
      new StaticCapabilityCatalog([capability('a')]),
      new StaticCapabilityCatalog([capability('b')]),
    ]);

    expect(catalog.list().map((c) => c.name)).toEqual(['a', 'b']);
    expect(catalog.has('a')).toBe(true);
    expect(catalog.has('b')).toBe(true);
  });

  it('lets the earlier catalog win a conflict, as documented', () => {
    const catalog = new CompositeCapabilityCatalog([
      new StaticCapabilityCatalog([capability('brief', { description: 'live' })]),
      new StaticCapabilityCatalog([capability('brief', { description: 'manifest' })]),
    ]);

    // `Map.set` unguarded would invert this and let the later one overwrite.
    expect(catalog.find('brief')?.description).toBe('live');
    expect(catalog.list()).toHaveLength(1);
  });

  it('does not treat a tool and an agent of the same name as a conflict', () => {
    const catalog = new CompositeCapabilityCatalog([
      new StaticCapabilityCatalog([capability('brief', { kind: 'tool' })]),
      new StaticCapabilityCatalog([capability('brief', { kind: 'agent' })]),
    ]);

    expect(catalog.list()).toHaveLength(2);
    expect(catalog.has('brief', 'agent')).toBe(true);
  });

  it('narrows has() by kind across its members', () => {
    const catalog = new CompositeCapabilityCatalog([
      new StaticCapabilityCatalog([capability('a', { kind: 'tool' })]),
    ]);

    expect(catalog.has('a', 'tool')).toBe(true);
    expect(catalog.has('a', 'agent')).toBe(false);
  });

  it('is empty when composed of nothing', () => {
    const catalog = new CompositeCapabilityCatalog([]);

    expect(catalog.list()).toEqual([]);
    expect(catalog.has('a')).toBe(false);
    expect(catalog.find('a')).toBeUndefined();
  });

  it('composes a live runtime over a declared manifest', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'live',
      setup: (ctx) => {
        ctx.registerTool(
          defineTool<unknown, string>({
            name: 'calendar.today',
            description: 'live',
            execute: () => Promise.resolve('ok'),
          }),
        );
      },
    });
    await runtime.start();

    // "Plan against what is registered, plus what we know a not-yet-loaded
    // plugin will register."
    const catalog = new CompositeCapabilityCatalog([
      new RuntimeCapabilityCatalog(runtime),
      new StaticCapabilityCatalog([
        capability('email.send', { description: 'pending plugin' }),
      ]),
    ]);

    expect(catalog.has('calendar.today', 'tool')).toBe(true);
    expect(catalog.has('email.send', 'tool')).toBe(true);

    await runtime.stop();
  });
});
