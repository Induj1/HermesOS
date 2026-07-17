/**
 * Tool authoring, and the two things `defineTool` does that the kernel's does not.
 *
 * The important one is output validation. The kernel declares `Tool.output` and
 * **never calls it** — `runtime.ts` `#invokeTool` parses input only — so a tool
 * that carefully declares an output schema gets no checking at all today. That is
 * pinned below as a property of the kernel, then closed here.
 */

import { describe, expect, it } from 'vitest';
import { defineTool as defineKernelTool, Runtime, sequentialIds } from '@hermes/kernel';
import { defineTool, isHermesTool, schemaOf } from '../src/tool.js';
import * as s from '../src/schema.js';
import {
  InvalidDefinitionError,
  InputInvalidError,
  OutputInvalidError,
} from '../src/errors.js';
import { callTool, testContext } from '../src/testing.js';

const readFile = defineTool({
  name: 'fs.read',
  description: 'Read a UTF-8 text file from disk.',
  tags: ['filesystem', 'read'],
  permissions: ['fs:read'],
  idempotent: true,
  version: '1.0.0',
  input: s.object({ path: s.string() }),
  output: s.string(),
  execute: ({ path }) => Promise.resolve(`contents of ${path}`),
});

describe('a Hermes tool is a kernel tool', () => {
  // The whole design in one assertion: it registers, unchanged, through the
  // kernel's ordinary API, with no kernel change and no adapter.
  it('registers on a real runtime', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fs',
      setup: (ctx) => {
        ctx.registerTool(readFile);
      },
    });
    await runtime.start();

    expect(runtime.tools.get('fs.read')?.name).toBe('fs.read');

    await runtime.stop();
  });

  it('runs through the kernel, validator and all', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fs',
      setup: (ctx) => {
        ctx.registerTool(readFile);
      },
    });
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'read',
      tasks: [
        {
          name: 'read',
          handler: { kind: 'tool', name: 'fs.read' },
          input: { path: '/tmp/a' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toBe('contents of /tmp/a');

    await runtime.stop();
  });

  it('carries metadata the kernel never reads', () => {
    expect(readFile.tags).toEqual(['filesystem', 'read']);
    expect(readFile.permissions).toEqual(['fs:read']);
    expect(readFile.idempotent).toBe(true);
  });
});

describe('input validation', () => {
  it('parses and types the input', async () => {
    expect(await callTool(readFile, { path: '/etc/hosts' })).toBe(
      'contents of /etc/hosts',
    );
  });

  // A SchemaError says `"path" must be a string` and does not know which tool it
  // belongs to. A model reading three failed observations cannot tell which one
  // complained.
  it('names the tool when the input is wrong', () => {
    expect(() => readFile.input?.parse({ path: 2 })).toThrow(InputInvalidError);
    expect(() => readFile.input?.parse({ path: 2 })).toThrow(
      'fs.read was called with invalid input: "path" must be a string',
    );
  });

  it('keeps the JSON Schema through the wrapping', () => {
    // The wrapper rebuilds the validator object. If it dropped `jsonSchema`, a
    // tool that carefully declared a schema would silently stop telling models
    // about it — this package's own bug, reintroduced by its own plumbing.
    expect(schemaOf(readFile)).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    });
  });
});

describe('output validation', () => {
  const broken = defineTool({
    name: 'broken',
    description: 'Declares a string output and returns a number',
    output: s.string(),
    execute: () => Promise.resolve(42 as unknown as string),
  });

  // Pinned as a property of the kernel, because this package's first draft
  // believed the opposite and wrapped `execute` to "fix" it — which double-parsed
  // every result. The kernel does validate: `#invokeTool` ends
  // `return tool.output ? tool.output.parse(output) : output`.
  it('is something the kernel already does', async () => {
    const lying = defineKernelTool<unknown, string>({
      name: 'lies',
      description: 'Declares a string output and returns a number',
      output: {
        parse: (value: unknown): string => {
          if (typeof value !== 'string') throw new TypeError('not a string');
          return value;
        },
      },
      execute: () => Promise.resolve(42 as unknown as string),
    });

    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(lying);
      },
    });
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'lie',
      tasks: [{ name: 'lie', handler: { kind: 'tool', name: 'lies' } }],
    });

    expect(snapshot.state).toBe('failed');

    await runtime.stop();
  });

  // What the kernel cannot do: say which side failed. Its `parse` contract is the
  // same on both, so a `SchemaError` from an output fault reads `input must be a
  // string` — exactly backwards, and a model told "input" about an output fault
  // will rewrite its arguments forever.
  it('reports an output fault as an output fault, through a real kernel', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(broken);
      },
    });
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'run',
      tasks: [{ name: 'run', handler: { kind: 'tool', name: 'broken' } }],
    });

    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /does not match its own output schema/,
    );
    // And explicitly not the kernel's bare, misattributing message.
    expect(snapshot.tasks[0]?.error?.message).not.toBe('input must be a string');

    await runtime.stop();
  });

  it('rejects a bad output through callTool too', async () => {
    await expect(callTool(broken, {})).rejects.toThrow(OutputInvalidError);
  });

  // A model reading this must not try to fix it by rewriting arguments, which is
  // the only thing it can do and the one thing that cannot help.
  it('says the fault is the tool, not the caller', async () => {
    await expect(callTool(broken, {})).rejects.toThrow(
      /fault in the tool, not in how it was called/,
    );
  });

  it('passes a valid output through untouched', async () => {
    expect(await callTool(readFile, { path: '/a' })).toBe('contents of /a');
  });

  it('leaves the result alone when no output schema was declared', async () => {
    const loose = defineTool({
      name: 'loose',
      description: 'Returns whatever it likes',
      execute: () => Promise.resolve({ anything: true }),
    });

    expect(await callTool(loose, {})).toEqual({ anything: true });
  });
});

describe('declaration validation', () => {
  // A tool that can never work is a wiring mistake; it should fail at module
  // load, where the wiring is.
  it('refuses a tool with no name', () => {
    expect(() =>
      defineTool({
        name: '  ',
        description: 'x'.repeat(20),
        execute: () => Promise.resolve(1),
      }),
    ).toThrow(InvalidDefinitionError);
  });

  // The description is what a model reads to decide whether to call this tool at
  // all. One that cannot describe itself will never be chosen, or chosen at random.
  it('refuses a tool with no description', () => {
    expect(() =>
      defineTool({ name: 'a', description: '   ', execute: () => Promise.resolve(1) }),
    ).toThrow(/non-empty description — a model reads it to choose/);
  });

  it('refuses a version that is not semantic', () => {
    expect(() =>
      defineTool({
        name: 'a',
        description: 'A tool that does things',
        version: 'v2',
        execute: () => Promise.resolve(1),
      }),
    ).toThrow(/not semantic/);
  });

  it('accepts a semantic version, including a prerelease', () => {
    expect(
      defineTool({
        name: 'a',
        description: 'A tool that does things',
        version: '1.2.3-beta.1',
        execute: () => Promise.resolve(1),
      }).version,
    ).toBe('1.2.3-beta.1');
  });

  it('names the tool in the error, or says it was unnamed', () => {
    expect(() =>
      defineTool({ name: '', description: '', execute: () => Promise.resolve(1) }),
    ).toThrow(/Tool "\(unnamed\)"/);
  });

  it('reports every issue at once, not the first', () => {
    try {
      defineTool({ name: '', description: '', execute: () => Promise.resolve(1) });
      expect.unreachable('should have thrown');
    } catch (thrown) {
      expect((thrown as InvalidDefinitionError).issues).toHaveLength(2);
    }
  });
});

describe('working with a plain kernel tool', () => {
  const plain = defineKernelTool<unknown, string>({
    name: 'plain',
    description: 'A tool written before this package existed',
    execute: () => Promise.resolve('ok'),
  });

  // Nothing is lost and nothing is invented: it degrades to what the kernel
  // already offered.
  it('reports no schema rather than fabricating one', () => {
    expect(schemaOf(plain)).toBeUndefined();
  });

  it('reports no schema for a validator that cannot describe itself', () => {
    const zodish = defineKernelTool<string, string>({
      name: 'zodish',
      description: 'Uses a hand-written validator, as the kernel intends',
      input: { parse: (input: unknown): string => String(input) },
      execute: (input) => Promise.resolve(input),
    });

    // A Zod schema satisfies `Validator` and has no `jsonSchema`. That door stays
    // open: the tool works, it just tells the model nothing about its arguments.
    expect(schemaOf(zodish)).toBeUndefined();
  });

  it('is recognised as a tool', () => {
    expect(isHermesTool(plain)).toBe(true);
  });
});

describe('testContext', () => {
  // A tool that reads `ctx.signal` in a test should get one that behaves, or it
  // passes every test and hangs in production.
  it('gives a real, un-aborted signal by default', () => {
    expect(testContext().signal.aborted).toBe(false);
  });

  it('gives a real logger and clock rather than a crash', () => {
    const ctx = testContext();

    expect(() => {
      ctx.logger.debug('hello');
    }).not.toThrow();
    expect(typeof ctx.clock.now()).toBe('number');
  });

  it('takes an aborted signal, so cancellation can be tested', () => {
    expect(testContext({ signal: AbortSignal.abort() }).signal.aborted).toBe(true);
  });

  it('names the task after the tool by default in callTool', async () => {
    const spy = defineTool({
      name: 'spy.tool',
      description: 'Reports the task name it was given',
      execute: (_input, ctx) => Promise.resolve(ctx.taskName),
    });

    expect(await callTool(spy, {})).toBe('spy.tool');
  });

  it('reports the attempt the kernel would', () => {
    expect(testContext({ attempt: 3 }).attempt).toBe(3);
    expect(testContext().attempt).toBe(1);
  });
});
