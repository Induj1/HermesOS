/**
 * The gap this package exists to close.
 *
 * These tests assert properties of the **kernel and the agent framework**, not of
 * this package: that a plain kernel tool can tell a model nothing about its
 * arguments, and that tag-based tool selection cannot work against one.
 *
 * They are here rather than in `packages/kernel/tests` deliberately, exactly as
 * the planner's `kernel-gap.test.ts` is (RFC-0003 §4). Neither is a bug. The
 * kernel refusing to know what a payload means is RFC-0001 §2, and it is right.
 * But it leaves a real hole one layer up, closing it is the single most valuable
 * thing this package does, and **a justification nobody checks is folklore**.
 *
 * **If one of these fails, the gap has closed** — and a good chunk of `tool.ts`
 * and `catalog.ts` should be deleted, along with the argument for them in
 * RFC-0006 §1. That is the signal these exist to send.
 */

import { describe, expect, it } from 'vitest';
import { defineTool as defineKernelTool, Runtime, sequentialIds } from '@hermes/kernel';
import { kernelExecutor } from '@hermes/agent';
import type { ToolAccess } from '@hermes/kernel';

/** A real kernel tool with a real input validator, written the way the kernel intends. */
const kernelTool = defineKernelTool<{ path: string }, string>({
  name: 'fs.read',
  description: 'Read a file',
  input: {
    parse: (input: unknown): { path: string } => {
      const raw = input as { path?: unknown } | undefined;
      if (typeof raw?.path !== 'string') throw new TypeError('path must be a string');
      return { path: raw.path };
    },
  },
  execute: () => Promise.resolve('contents'),
});

describe('the kernel does not carry a tool argument schema', () => {
  it('offers no way to declare one', () => {
    // `Tool` is name, description, input?, output?, execute. The validator can
    // *check* `{ path: string }` and cannot *describe* it: `parse` is a function,
    // and a function cannot be sent to a model.
    expect(Object.keys(kernelTool).sort()).toEqual([
      'description',
      'execute',
      'input',
      'name',
    ]);
    expect(kernelTool).not.toHaveProperty('parameters');
    expect(kernelTool).not.toHaveProperty('schema');
  });

  it('does not surface one through ToolAccess', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(kernelTool);
      },
    });
    await runtime.start();

    // The kernel's own view of a tool, and the only view an agent gets.
    const listed = runtime.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));

    expect(listed).toEqual([{ name: 'fs.read', description: 'Read a file' }]);

    await runtime.stop();
  });
});

describe('so a model is told a tool exists and not what it takes', () => {
  const toolsOf = (runtime: Runtime): ToolAccess => ({
    has: (name) => runtime.tools.has(name),
    list: () =>
      runtime.tools
        .list()
        .map((tool) => ({ name: tool.name, description: tool.description })),
    invoke: () => Promise.resolve(undefined),
  });

  it('reports no parameters, which is what LlmReasoner hands the model', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(kernelTool);
      },
    });
    await runtime.start();

    const available = kernelExecutor(toolsOf(runtime)).available();

    // This is the cost, in one assertion. `AvailableCapability.parameters` is
    // declared, `LlmReasoner` passes it into `ToolDefinition.parameters`, and it
    // is `undefined` — so the model is told `fs.read` exists and must guess that
    // it takes `{ path: string }`. It will guess `{ file }`, or `{ filename }`,
    // and every call will fail on a validator it was never shown.
    expect(available).toEqual([
      { name: 'fs.read', kind: 'tool', description: 'Read a file' },
    ]);
    expect(available[0]?.parameters).toBeUndefined();

    await runtime.stop();
  });

  it('reports no tags, so tag-based tool selection matches nothing', async () => {
    const runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use({
      name: 'fixtures',
      setup: (ctx) => {
        ctx.registerTool(kernelTool);
      },
    });
    await runtime.start();

    const available = kernelExecutor(toolsOf(runtime)).available();

    // `NamedTools({ tags: ['filesystem'] })` filters on `capability.tags`. Against
    // a kernel-registered tool that is always undefined, so the selector is not
    // merely unhelpful — it is empty, and an agent configured with it sees no
    // tools at all.
    expect(available[0]?.tags).toBeUndefined();

    await runtime.stop();
  });
});
