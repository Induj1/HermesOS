/**
 * The claim `catalog.ts` makes about itself, checked.
 *
 * `describe()` returns a shape that is **structurally identical** to
 * `@hermes/agent`'s `AvailableCapability`, so a host assigns it straight across
 * with no adapter — and this package never imports the agent framework, because a
 * tool package that depended on the reasoning framework would point the
 * dependency graph outward (RFC-0006 §3).
 *
 * That claim spans two packages, so it needs a place where both are visible.
 * `@hermes/agent` is a **devDependency** here for exactly this file: the test
 * needs to see it, the code must not. If the shapes ever diverge, `pnpm
 * typecheck` fails here rather than a host discovering it at a call site.
 *
 * Same move, same reason, as `EmbeddingModel` and memory's `EmbeddingProvider`
 * (RFC-0005 §4.2).
 */

import { describe, expect, it } from 'vitest';
import type { AvailableCapability } from '@hermes/agent';
import { NamedTools } from '@hermes/agent';
import { describe as describeTool } from '../src/catalog.js';
import { defineTool } from '../src/tool.js';
import * as s from '../src/schema.js';

const readFile = defineTool({
  name: 'fs.read',
  description: 'Read a UTF-8 text file.',
  tags: ['filesystem', 'read'],
  input: s.object({ path: s.string() }),
  execute: () => Promise.resolve('contents'),
});

describe('a ToolDescription is an AvailableCapability', () => {
  it('assigns straight across, with no adapter', () => {
    // The assignment is the test. It does not compile if the shapes diverge.
    const capability: AvailableCapability = describeTool(readFile);

    expect(capability.name).toBe('fs.read');
    expect(capability.kind).toBe('tool');
  });

  it('carries the parameters LlmReasoner hands the model', () => {
    const capability: AvailableCapability = describeTool(readFile);

    // The gap closed, end to end: `kernel-gap.test.ts` shows this undefined for a
    // plain kernel tool.
    expect(capability.parameters).toMatchObject({ type: 'object', required: ['path'] });
  });

  it('carries the tags an agent selector filters on', () => {
    const capability: AvailableCapability = describeTool(readFile);

    expect(capability.tags).toEqual(['filesystem', 'read']);
  });

  // The other half of the gap, closed against the real selector rather than a
  // reimplementation of it. Against a plain kernel tool this returns nothing,
  // because `tags` is always undefined.
  it('is selectable by tag, using the agent framework own strategy', () => {
    const selected = new NamedTools({ tags: ['filesystem'] }).select({ input: 'x' }, [
      describeTool(readFile),
    ]);

    expect(selected.map((capability) => capability.name)).toEqual(['fs.read']);
  });

  it('is not selected by a tag it does not carry', () => {
    const selected = new NamedTools({ tags: ['network'] }).select({ input: 'x' }, [
      describeTool(readFile),
    ]);

    expect(selected).toEqual([]);
  });
});
