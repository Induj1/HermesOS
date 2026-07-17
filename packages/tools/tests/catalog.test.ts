/**
 * Discovery — where the gap actually closes.
 *
 * `kernel-gap.test.ts` shows a plain kernel tool telling a model nothing. These
 * show the same tool, authored with this framework, telling it everything — and
 * that the two are the same registry, the same runtime, and no kernel change.
 */

import { describe, expect, it } from 'vitest';
import {
  defineTool as defineKernelTool,
  Registry,
  Runtime,
  sequentialIds,
} from '@hermes/kernel';
import type { Tool } from '@hermes/kernel';
import {
  catalog,
  describe as describeTool,
  toModelDefinition,
} from '../src/catalog.js';
import { defineTool } from '../src/tool.js';
import * as s from '../src/schema.js';
import { PermissionSet } from '../src/permissions.js';

const readFile = defineTool({
  name: 'fs.read',
  description: 'Read a UTF-8 text file.',
  tags: ['filesystem', 'read'],
  permissions: ['fs:read'],
  idempotent: true,
  version: '1.2.0',
  input: s.object({ path: s.string({ description: 'Absolute path.' }) }),
  execute: () => Promise.resolve('contents'),
});

const writeFile = defineTool({
  name: 'fs.write',
  description: 'Write a UTF-8 text file.',
  tags: ['filesystem', 'write'],
  permissions: ['fs:write'],
  input: s.object({ path: s.string(), body: s.string() }),
  execute: () => Promise.resolve(undefined),
});

const registryOf = (...tools: Tool[]): Registry<Tool> => {
  const registry = new Registry<Tool>('tool');
  for (const tool of tools) registry.register(tool);
  return registry;
};

describe('describe', () => {
  // The gap, closed. Compare with kernel-gap.test.ts, where `parameters` and
  // `tags` are both undefined for the same shape of tool.
  it('reports the schema and tags a plain kernel tool cannot carry', () => {
    const described = describeTool(readFile);

    expect(described.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path.' } },
      required: ['path'],
      additionalProperties: false,
    });
    expect(described.tags).toEqual(['filesystem', 'read']);
  });

  it('reports the rest of the metadata', () => {
    expect(describeTool(readFile)).toMatchObject({
      name: 'fs.read',
      kind: 'tool',
      permissions: ['fs:read'],
      version: '1.2.0',
      idempotent: true,
    });
  });

  // Nothing is lost and nothing is invented: it degrades to what the kernel
  // already offered, which is name and description.
  it('degrades honestly for a tool that did not use this framework', () => {
    const plain = defineKernelTool<unknown, string>({
      name: 'plain',
      description: 'Written before this package existed',
      execute: () => Promise.resolve('ok'),
    });

    expect(describeTool(plain)).toEqual({
      name: 'plain',
      kind: 'tool',
      description: 'Written before this package existed',
    });
  });

  it('never fabricates a schema', () => {
    const plain = defineKernelTool<unknown, string>({
      name: 'plain',
      description: 'No schema',
      execute: () => Promise.resolve('ok'),
    });

    // A model told nothing is better off than a model told a guess.
    expect(describeTool(plain).parameters).toBeUndefined();
  });
});

describe('rendering the description a model reads', () => {
  const withExamples = defineTool({
    name: 'search',
    description: 'Search the index.',
    input: s.object({ q: s.string() }),
    examples: [
      { description: 'Find a person', input: { q: 'ada lovelace' } },
      { description: 'With a result', input: { q: 'x' }, output: ['a hit'] },
    ],
    execute: () => Promise.resolve([]),
  });

  // The highest-leverage thing this function does: an example resolves the
  // ambiguities a JSON Schema cannot express.
  it('folds examples in, because ToolDefinition has nowhere else to put them', () => {
    const description = describeTool(withExamples).description;

    expect(description).toContain('Search the index.');
    expect(description).toContain('Find a person: {"q":"ada lovelace"}');
    expect(description).toContain('With a result: {"q":"x"} -> ["a hit"]');
  });

  it('leaves them out when asked, because they cost tokens every turn', () => {
    expect(describeTool(withExamples, { examples: false }).description).toBe(
      'Search the index.',
    );
  });

  // A model cannot read a `deprecated` field it is never shown, and the whole
  // point of deprecating a tool is that the thing choosing it stops choosing it.
  it('warns about a deprecated tool first, where a model will read it', () => {
    const old = defineTool({
      name: 'old',
      description: 'Does the thing.',
      deprecated: 'Use fs.read instead.',
      execute: () => Promise.resolve(1),
    });

    expect(describeTool(old).description).toBe(
      'DEPRECATED: Use fs.read instead.\nDoes the thing.',
    );
  });

  it('can be told not to', () => {
    const old = defineTool({
      name: 'old',
      description: 'Does the thing.',
      deprecated: 'Use fs.read instead.',
      execute: () => Promise.resolve(1),
    });

    expect(describeTool(old, { deprecation: false }).description).toBe(
      'Does the thing.',
    );
  });

  // An example is documentation. A circular one is an authoring mistake that
  // should show up as a scruffy description, not take down every tool
  // description in the process.
  it('survives an example that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const odd = defineTool({
      name: 'odd',
      description: 'Has a bad example.',
      examples: [{ description: 'Circular', input: circular }],
      execute: () => Promise.resolve(1),
    });

    expect(describeTool(odd).description).toContain('(unserialisable example)');
  });
});

describe('toModelDefinition', () => {
  // The projection is trivial *because* describe already did the work — the point
  // of one description with two renderings rather than two descriptions.
  it('renders the vocabulary chatWithTools takes', () => {
    expect(toModelDefinition(readFile)).toEqual({
      name: 'fs.read',
      description: 'Read a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path.' } },
        required: ['path'],
        additionalProperties: false,
      },
    });
  });

  it('omits parameters for a tool that declared none', () => {
    const plain = defineKernelTool<unknown, string>({
      name: 'plain',
      description: 'No schema at all',
      execute: () => Promise.resolve('ok'),
    });

    expect(toModelDefinition(plain)).not.toHaveProperty('parameters');
  });
});

describe('catalog', () => {
  it('describes a whole registry', () => {
    expect(catalog(registryOf(readFile, writeFile)).map((t) => t.name)).toEqual([
      'fs.read',
      'fs.write',
    ]);
  });

  it('reads a real runtime registry, without touching the runtime', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fs',
      setup: (ctx) => {
        ctx.registerTool(readFile);
      },
    });
    await runtime.start();

    // `runtime.tools` is already a ReadonlyRegistry. A catalog that took a
    // Runtime could run a tool, and would not be a catalog.
    expect(catalog(runtime.tools)[0]?.parameters).toBeDefined();

    await runtime.stop();
  });

  it('filters by tag', () => {
    const selected = catalog(registryOf(readFile, writeFile), { tags: ['write'] });

    expect(selected.map((t) => t.name)).toEqual(['fs.write']);
  });

  it('keeps a tool matching any of several tags', () => {
    expect(
      catalog(registryOf(readFile, writeFile), { tags: ['read', 'write'] }),
    ).toHaveLength(2);
  });

  it('does not filter when no tags are asked for', () => {
    expect(catalog(registryOf(readFile, writeFile), { tags: [] })).toHaveLength(2);
  });

  // A model shown a tool it may not use will ask for it, be refused, and spend a
  // turn learning what it could have been told for free — and it now knows the
  // tool exists, which for a hidden capability is what the host was avoiding.
  it('hides tools whose permissions are not granted', () => {
    const granted = PermissionSet.none().grant('fs:read');

    const selected = catalog(registryOf(readFile, writeFile), { granted });

    expect(selected.map((t) => t.name)).toEqual(['fs.read']);
  });

  it('shows a tool that declares no permissions', () => {
    const free = defineTool({
      name: 'free',
      description: 'Needs nothing at all',
      execute: () => Promise.resolve(1),
    });

    expect(catalog(registryOf(free), { granted: PermissionSet.none() })).toHaveLength(
      1,
    );
  });

  it('shows everything under a full grant', () => {
    expect(
      catalog(registryOf(readFile, writeFile), { granted: PermissionSet.all() }),
    ).toHaveLength(2);
  });

  it('hides deprecated tools when asked', () => {
    const old = defineTool({
      name: 'old',
      description: 'Superseded.',
      deprecated: 'Use fs.read.',
      execute: () => Promise.resolve(1),
    });

    expect(
      catalog(registryOf(readFile, old), { hideDeprecated: true }).map((t) => t.name),
    ).toEqual(['fs.read']);
  });

  it('describes deprecated tools by default, so a model can be told to stop', () => {
    const old = defineTool({
      name: 'old',
      description: 'Superseded.',
      deprecated: 'Use fs.read.',
      execute: () => Promise.resolve(1),
    });

    expect(catalog(registryOf(old))).toHaveLength(1);
  });

  it('combines filters', () => {
    const selected = catalog(registryOf(readFile, writeFile), {
      tags: ['filesystem'],
      granted: PermissionSet.none().grant('fs:read'),
    });

    expect(selected.map((t) => t.name)).toEqual(['fs.read']);
  });

  it('is empty for an empty registry', () => {
    expect(catalog(registryOf())).toEqual([]);
  });
});
