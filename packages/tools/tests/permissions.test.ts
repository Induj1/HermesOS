/**
 * Permissions, the wrappers that enforce them, and toolsets.
 *
 * The theme is that a grant is a property of the **host**, not of the tool — so
 * every enforcement point here takes the grant from outside and a tool never
 * asks about itself.
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { assertPermitted, PermissionSet } from '../src/permissions.js';
import {
  withMiddleware,
  withPermissions,
  withPermissionsAll,
} from '../src/middleware.js';
import type { ToolMiddleware } from '../src/middleware.js';
import { toolset } from '../src/toolset.js';
import { defineTool } from '../src/tool.js';
import * as s from '../src/schema.js';
import { InvalidDefinitionError, PermissionDeniedError } from '../src/errors.js';
import { callTool } from '../src/testing.js';

const writeFile = defineTool({
  name: 'fs.write',
  description: 'Write a UTF-8 text file.',
  permissions: ['fs:write'],
  input: s.object({ path: s.string() }),
  execute: ({ path }) => Promise.resolve(`wrote ${path}`),
});

describe('PermissionSet', () => {
  it('grants exactly what it was given', () => {
    const granted = new PermissionSet(['fs:read']);

    expect(granted.has('fs:read')).toBe(true);
    expect(granted.has('fs:write')).toBe(false);
  });

  it('grants a whole domain with a wildcard', () => {
    const granted = new PermissionSet(['fs:*']);

    expect(granted.has('fs:read')).toBe(true);
    expect(granted.has('fs:write')).toBe(true);
    expect(granted.has('net:http')).toBe(false);
  });

  // "Everything that reads" reads like a safe grant and is not: it spans every
  // domain, including ones a plugin installs later that nobody reviewed.
  it('does not support a wildcard on the action, only on the domain', () => {
    expect(new PermissionSet(['*:read']).has('fs:read')).toBe(false);
  });

  it('handles a permission with no domain at all', () => {
    expect(new PermissionSet(['fs:*']).has('bare')).toBe(false);
    expect(new PermissionSet(['bare']).has('bare')).toBe(true);
  });

  it('grants everything under a bare wildcard', () => {
    expect(PermissionSet.all().has('anything:at:all')).toBe(true);
  });

  it('grants nothing by default', () => {
    expect(PermissionSet.none().has('fs:read')).toBe(false);
    expect(PermissionSet.none().size).toBe(0);
  });

  it('reports what is missing, which is what an operator needs to grant', () => {
    const granted = new PermissionSet(['fs:read']);

    expect(granted.missing(['fs:read', 'fs:write', 'net:http'])).toEqual([
      'fs:write',
      'net:http',
    ]);
    expect(granted.missing(['fs:read'])).toEqual([]);
  });

  // A set that could be widened after construction would make "what is this host
  // allowed to do" depend on when you asked, decided by whichever plugin loaded
  // last — the race the kernel's registry exists to prevent.
  it('is immutable: granting returns a copy', () => {
    const original = PermissionSet.none();

    const wider = original.grant('fs:read');

    expect(wider.has('fs:read')).toBe(true);
    expect(original.has('fs:read')).toBe(false);
  });

  it('lists what it holds, sorted, for an operator log', () => {
    expect(new PermissionSet(['net:http', 'fs:read']).list()).toEqual([
      'fs:read',
      'net:http',
    ]);
  });
});

describe('assertPermitted', () => {
  it('permits a tool that needs nothing', () => {
    expect(() => {
      assertPermitted('t', undefined, PermissionSet.none());
    }).not.toThrow();
    expect(() => {
      assertPermitted('t', [], PermissionSet.none());
    }).not.toThrow();
  });

  it('permits a tool whose needs are met', () => {
    expect(() => {
      assertPermitted('t', ['fs:read'], new PermissionSet(['fs:read']));
    }).not.toThrow();
  });

  it('names the tool and the permission an operator must grant', () => {
    const denied = (): void => {
      assertPermitted('fs.write', ['fs:write'], PermissionSet.none());
    };

    expect(denied).toThrow(PermissionDeniedError);
    expect(denied).toThrow('fs.write requires the "fs:write" permission');
  });

  // A model reading this must learn to stop, not to rewrite its arguments.
  it('tells a model that retrying will not help', () => {
    expect(() => {
      assertPermitted('fs.write', ['fs:write'], PermissionSet.none());
    }).toThrow(/Retrying with different arguments will not help/);
  });

  // Deliberately unlike everywhere else in the repo, which reports every issue at
  // once. The audience decides it: an operator grants one at a time and re-runs,
  // and a model needs "stop" rather than a menu.
  it('names one permission and mentions the rest, rather than listing them all', () => {
    const denied = (): void => {
      assertPermitted('t', ['a:1', 'b:2', 'c:3'], PermissionSet.none());
    };

    expect(denied).toThrow('requires the "a:1" permission');
    expect(denied).toThrow('it also needs b:2, c:3');
  });
});

describe('withPermissions', () => {
  it('refuses a tool that was not granted what it declares', async () => {
    const guarded = withPermissions(writeFile, PermissionSet.none());

    await expect(callTool(guarded, { path: '/tmp/a' })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('lets a granted tool through', async () => {
    const guarded = withPermissions(writeFile, new PermissionSet(['fs:write']));

    expect(await callTool(guarded, { path: '/tmp/a' })).toBe('wrote /tmp/a');
  });

  it('leaves a tool that needs nothing alone', () => {
    const free = defineTool({
      name: 'free',
      description: 'Needs no permission at all',
      execute: () => Promise.resolve(1),
    });

    // Returned unwrapped: there is nothing to guard.
    expect(withPermissions(free, PermissionSet.none())).toBe(free);
  });

  // If a wrapper dropped the schema, a guarded tool would silently stop telling
  // models what it takes — this package's own bug, via its own plumbing.
  it('keeps the name, the schema and the metadata', () => {
    const guarded = withPermissions(writeFile, PermissionSet.all());

    expect(guarded.name).toBe('fs.write');
    expect(guarded.input).toBe(writeFile.input);
    expect(guarded.permissions).toEqual(['fs:write']);
  });

  it('guards every call, not just the first', async () => {
    const guarded = withPermissions(writeFile, PermissionSet.none());

    await expect(callTool(guarded, { path: '/a' })).rejects.toThrow(
      PermissionDeniedError,
    );
    await expect(callTool(guarded, { path: '/b' })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('guards a whole set in one act, which is how none gets forgotten', async () => {
    const guarded = withPermissionsAll([writeFile], PermissionSet.none());

    await expect(
      callTool(guarded[0] as typeof writeFile, { path: '/a' }),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe('withMiddleware', () => {
  it('returns the tool untouched when there is no middleware', () => {
    expect(withMiddleware(writeFile, [])).toBe(writeFile);
  });

  it('runs the first middleware outermost', async () => {
    const order: string[] = [];
    const tag =
      (name: string): ToolMiddleware<{ path: string }, string> =>
      async (input, ctx, next) => {
        order.push(`${name}:in`);
        const result = await next(input, ctx);
        order.push(`${name}:out`);
        return result;
      };

    await callTool(withMiddleware(writeFile, [tag('first'), tag('second')]), {
      path: '/a',
    });

    expect(order).toEqual(['first:in', 'second:in', 'second:out', 'first:out']);
  });

  it('lets a middleware rewrite the input', async () => {
    const root: ToolMiddleware<{ path: string }, string> = async (input, ctx, next) =>
      await next({ ...input, path: `/sandbox${input.path}` }, ctx);

    expect(await callTool(withMiddleware(writeFile, [root]), { path: '/a' })).toBe(
      'wrote /sandbox/a',
    );
  });

  it('lets a middleware refuse without calling the tool', async () => {
    const execute = vi.fn<(input: { path: string }) => Promise<string>>();
    const readOnly: ToolMiddleware<{ path: string }, string> = () => {
      throw new Error('read-only mode');
    };
    const spy = defineTool({
      name: 'spy',
      description: 'Records that it ran',
      input: s.object({ path: s.string() }),
      execute,
    });

    await expect(
      callTool(withMiddleware(spy, [readOnly]), { path: '/a' }),
    ).rejects.toThrow('read-only mode');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the tool name and schema', () => {
    const passthrough: ToolMiddleware<{ path: string }, string> = async (
      input,
      ctx,
      next,
    ) => await next(input, ctx);
    const wrapped = withMiddleware(writeFile, [passthrough]);

    expect(wrapped.name).toBe('fs.write');
    expect(wrapped.input).toBe(writeFile.input);
  });
});

describe('toolset', () => {
  it('registers every tool on a real runtime', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(toolset({ name: 'fs', tools: [writeFile] }));
    await runtime.start();

    expect(runtime.tools.has('fs.write')).toBe(true);

    await runtime.stop();
  });

  // The thing this function is really for: eight tools tagged in one place rather
  // than eight places, one of which is wrong.
  it('adds the set tags to every tool', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(toolset({ name: 'fs', tags: ['filesystem'], tools: [writeFile] }));
    await runtime.start();

    expect((runtime.tools.get('fs.write') as typeof writeFile).tags).toEqual([
      'filesystem',
    ]);

    await runtime.stop();
  });

  // A tool's own tag and the set's say different things; overwriting would
  // silently discard the more specific.
  it('adds to a tool own tags rather than replacing them', async () => {
    const tagged = defineTool({
      name: 'fs.read',
      description: 'Read a file from disk',
      tags: ['read'],
      execute: () => Promise.resolve('x'),
    });
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(toolset({ name: 'fs', tags: ['filesystem'], tools: [tagged] }));
    await runtime.start();

    expect((runtime.tools.get('fs.read') as typeof tagged).tags).toEqual([
      'read',
      'filesystem',
    ]);

    await runtime.stop();
  });

  it('does not duplicate a tag the tool already had', async () => {
    const tagged = defineTool({
      name: 'fs.read',
      description: 'Read a file from disk',
      tags: ['filesystem'],
      execute: () => Promise.resolve('x'),
    });
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(toolset({ name: 'fs', tags: ['filesystem'], tools: [tagged] }));
    await runtime.start();

    expect((runtime.tools.get('fs.read') as typeof tagged).tags).toEqual([
      'filesystem',
    ]);

    await runtime.stop();
  });

  // Registered-and-refused rather than absent: a tool that vanishes is
  // indistinguishable from one never installed, and a model will keep looking.
  it('guards the set with one grant, and still registers what it refuses', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(
      toolset({ name: 'fs', tools: [writeFile], granted: PermissionSet.none() }),
    );
    await runtime.start();

    expect(runtime.tools.has('fs.write')).toBe(true);
    const snapshot = await runtime.run({
      name: 'write',
      tasks: [
        {
          name: 'w',
          handler: { kind: 'tool', name: 'fs.write' },
          input: { path: '/a' },
        },
      ],
    });
    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "fs:write" permission/,
    );

    await runtime.stop();
  });

  it('leaves the set unguarded when no grant is given', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(toolset({ name: 'fs', tools: [writeFile] }));
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'write',
      tasks: [
        {
          name: 'w',
          handler: { kind: 'tool', name: 'fs.write' },
          input: { path: '/a' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toBe('wrote /a');

    await runtime.stop();
  });

  it('refuses an empty set at wiring, where the mistake is', () => {
    expect(() => toolset({ name: 'empty', tools: [] })).toThrow(InvalidDefinitionError);
  });

  // The kernel would catch this at start(), naming the registry. Caught here, it
  // names the set the author is looking at.
  it('refuses a duplicate name, naming the set', () => {
    expect(() => toolset({ name: 'fs', tools: [writeFile, writeFile] })).toThrow(
      /Tool "fs" is not a valid definition: duplicate tool name "fs.write"/,
    );
  });

  it('carries a version onto the plugin', () => {
    expect(toolset({ name: 'fs', version: '2.0.0', tools: [writeFile] }).version).toBe(
      '2.0.0',
    );
  });
});
