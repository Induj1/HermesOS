/**
 * The gap this subsystem exists to close.
 *
 * These tests assert a property of the **kernel**, not of the planner: that a
 * mission naming a capability which does not exist is accepted, submitted, and
 * partially executed before anything notices.
 *
 * They are here rather than in `packages/kernel/tests` deliberately. The kernel
 * is frozen and this is not a kernel bug — resolving handlers at dispatch is
 * correct for a scheduler whose plugins register capabilities right up until
 * `start()`. But it is a real gap, it is the planner's primary justification, and
 * a justification that nobody checks is folklore.
 *
 * **If one of these tests fails, the kernel has closed the gap** — and a good
 * chunk of `PlanValidator` should be deleted, along with the argument for it in
 * RFC-0003 §4. That is the signal these tests exist to send.
 */

import { describe, expect, it } from 'vitest';
import { defineTool, Runtime, sequentialIds } from '@hermes/kernel';

/** A runtime with exactly one real tool, which records that it ran. */
function runtimeWithOneTool(ran: string[]): Runtime {
  const runtime = Runtime.create({ ids: sequentialIds() });
  runtime.use({
    name: 'fixtures',
    setup(ctx) {
      ctx.registerTool(
        defineTool<unknown, string>({
          name: 'real.tool',
          description: 'A tool that exists and has an effect',
          execute: () => {
            ran.push('real.tool');
            return Promise.resolve('done');
          },
        }),
      );
    },
  });
  return runtime;
}

describe('the kernel does not validate handlers at mission creation', () => {
  it('accepts a mission naming a tool that does not exist', async () => {
    const runtime = runtimeWithOneTool([]);
    await runtime.start();

    // Mission.create validates names, cycles, attempt counts — not handlers.
    // This does not throw, and that is the gap.
    expect(() =>
      runtime.createMission({
        name: 'typo',
        tasks: [
          { name: 'go', handler: { kind: 'tool', name: 'tool.that.does.not.exist' } },
        ],
      }),
    ).not.toThrow();

    await runtime.stop();
  });

  it('runs upstream tasks for real before the missing handler is noticed', async () => {
    // The whole cost of the gap, in one test. `real.tool` has its effect — imagine
    // it sent the email — and only then does the typo surface. Nothing undoes it.
    const ran: string[] = [];
    const runtime = runtimeWithOneTool(ran);
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'half-done',
      tasks: [
        { name: 'first', handler: { kind: 'tool', name: 'real.tool' } },
        {
          name: 'second',
          handler: { kind: 'tool', name: 'tool.that.does.not.exist' },
          dependsOn: ['first'],
        },
      ],
    });

    expect(snapshot.state).toBe('failed');
    // The effect happened.
    expect(ran).toEqual(['real.tool']);
    expect(snapshot.tasks.find((task) => task.name === 'first')?.state).toBe(
      'succeeded',
    );

    // And the failure arrives from inside the scheduler, at dispatch, as a
    // NotFoundError — long after the point where it could have been prevented.
    const failed = snapshot.tasks.find((task) => task.name === 'second');
    expect(failed?.state).toBe('failed');
    expect(failed?.error?.message).toMatch(/No tool named "tool.that.does.not.exist"/);

    await runtime.stop();
  });

  it('does not notice a handler kind mismatch either', async () => {
    // `real.tool` exists — as a tool. Asking for it as an agent is a different
    // mistake with a different fix, and the kernel catches neither until dispatch.
    const runtime = runtimeWithOneTool([]);
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'wrong-kind',
      tasks: [{ name: 'go', handler: { kind: 'agent', name: 'real.tool' } }],
    });

    expect(snapshot.state).toBe('failed');
    expect(snapshot.tasks[0]?.error?.message).toMatch(/No agent named "real.tool"/);

    await runtime.stop();
  });
});
