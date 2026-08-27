/**
 * The approval gate.
 *
 * The theme is that this guard protects effects that cannot be taken back, so
 * every ambiguous path has to end in "the tool did not run". Most of these tests
 * therefore assert on the spy inside `execute` rather than only on the thrown
 * error: an error is what the caller sees, but whether the effect happened is
 * what the gate exists to decide, and the two can disagree.
 */

import { describe, expect, it, vi } from 'vitest';
import { CancellationError } from '@hermes/kernel';
import type { Clock } from '@hermes/kernel';
import {
  autoApprove,
  denyAll,
  guard,
  withApproval,
  withApprovalAll,
} from '../src/approval.js';
import type { ApprovalRequest, Approver } from '../src/approval.js';
import { ApprovalDeniedError, PermissionDeniedError } from '../src/errors.js';
import { PermissionSet } from '../src/permissions.js';
import * as s from '../src/schema.js';
import { callTool } from '../src/testing.js';
import { defineTool } from '../src/tool.js';

/** A tool that records whether its effect actually happened. */
function deployTool() {
  const effect = vi.fn();
  const tool = defineTool({
    name: 'deploy',
    description: 'Deploy the service to an environment.',
    requiresApproval: 'replaces the running production service',
    permissions: ['deploy:prod'],
    input: s.object({ environment: s.string() }),
    execute: ({ environment }) => {
      effect(environment);
      return Promise.resolve(`deployed to ${environment}`);
    },
  });
  return { tool, effect };
}

/** A clock whose sleeps only finish when a test says so. */
function fakeClock(): { clock: Clock; expire: () => void } {
  const pending: (() => void)[] = [];

  const clock: Clock = {
    now: () => 0,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new CancellationError('Sleep aborted'));
          return;
        }
        const onAbort = (): void => {
          reject(new CancellationError('Sleep aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.push(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      }),
  };

  return {
    clock,
    expire: () => {
      pending.shift()?.();
    },
  };
}

/** Never answers. Stands in for a person who has not looked at their phone. */
const silent: Approver = () => new Promise<never>(() => undefined);

describe('withApproval', () => {
  it('leaves a tool that does not ask for approval completely alone', () => {
    const plain = defineTool({
      name: 'fs.read',
      description: 'Read a UTF-8 text file from disk.',
      execute: () => Promise.resolve('contents'),
    });

    // Identity, not an equivalent wrapper: a host applies this to a whole
    // toolset, and every tool that does not need a person should come back out
    // as the object that went in.
    expect(withApproval(plain, denyAll)).toBe(plain);
  });

  it('runs the tool once a person approves', async () => {
    const { tool, effect } = deployTool();

    const result = await callTool(withApproval(tool, autoApprove), {
      environment: 'production',
    });

    expect(result).toBe('deployed to production');
    expect(effect).toHaveBeenCalledWith('production');
  });

  it('does not run the tool when a person refuses', async () => {
    const { tool, effect } = deployTool();
    const gated = withApproval(tool, () =>
      Promise.resolve({
        approved: false,
        reason: 'staging only until the incident is closed',
      }),
    );

    await expect(callTool(gated, { environment: 'production' })).rejects.toThrow(
      ApprovalDeniedError,
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it('carries the refusal reason into the error, for a model to replan against', async () => {
    const { tool } = deployTool();
    const gated = withApproval(tool, () =>
      Promise.resolve({
        approved: false,
        reason: 'staging only until the incident is closed',
      }),
    );

    await expect(callTool(gated, { environment: 'production' })).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
      tool: 'deploy',
      requirement: 'replaces the running production service',
      reason: 'staging only until the incident is closed',
    });
  });

  it('shows the approver the actual arguments, not just the tool name', async () => {
    const { tool } = deployTool();
    const seen: ApprovalRequest[] = [];

    await callTool(
      withApproval(tool, (request) => {
        seen.push(request);
        return Promise.resolve({ approved: true });
      }),
      { environment: 'production' },
      { attempt: 3 },
    );

    expect(seen[0]).toMatchObject({
      tool: 'deploy',
      reason: 'replaces the running production service',
      input: { environment: 'production' },
      attempt: 3,
    });
  });

  // The gate is for effects, and a retry is a new effect. A cache here would
  // silently turn "yes to this call" into a standing grant on the tool name.
  it('asks again on every call', async () => {
    const { tool } = deployTool();
    const approver = vi.fn(autoApprove);
    const gated = withApproval(tool, approver);

    await callTool(gated, { environment: 'staging' });
    await callTool(gated, { environment: 'production' });

    expect(approver).toHaveBeenCalledTimes(2);
  });

  describe('failing closed', () => {
    it('denies when the approver itself throws', async () => {
      const { tool, effect } = deployTool();
      const gated = withApproval(tool, () =>
        Promise.reject(new Error('approval queue unreachable')),
      );

      await expect(callTool(gated, { environment: 'production' })).rejects.toThrow(
        ApprovalDeniedError,
      );
      expect(effect).not.toHaveBeenCalled();
    });

    it('says the gate broke rather than that someone refused', async () => {
      const { tool } = deployTool();
      const gated = withApproval(tool, () =>
        Promise.reject(new Error('approval queue unreachable')),
      );

      await expect(callTool(gated, { environment: 'production' })).rejects.toThrow(
        /could not be reached: approval queue unreachable/,
      );
    });

    it('denies when nobody answers in time', async () => {
      const { tool, effect } = deployTool();
      const { clock, expire } = fakeClock();

      const call = callTool(
        withApproval(tool, silent, { timeoutMs: 1000 }),
        { environment: 'production' },
        { clock },
      );
      expire();

      await expect(call).rejects.toThrow(/no decision within 1000ms/);
      expect(effect).not.toHaveBeenCalled();
    });

    it('refuses anything that is not an explicit approval', async () => {
      const { tool, effect } = deployTool();
      const gated = withApproval(tool, () => Promise.resolve({ approved: false }));

      await expect(callTool(gated, { environment: 'production' })).rejects.toThrow(
        ApprovalDeniedError,
      );
      expect(effect).not.toHaveBeenCalled();
    });
  });

  // Cancellation is the one path that must *not* flatten into a denial: a
  // recovery policy reading the failure needs "a human said no" (do not retry)
  // to look different from "we were cancelled" (retry on resume).
  it('propagates cancellation instead of reporting it as a refusal', async () => {
    const { tool, effect } = deployTool();
    const { clock } = fakeClock();
    const controller = new AbortController();

    const call = callTool(
      withApproval(tool, silent),
      { environment: 'production' },
      { clock, signal: controller.signal },
    );
    controller.abort();

    await expect(call).rejects.toThrow(CancellationError);
    await expect(call).rejects.not.toThrow(ApprovalDeniedError);
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not wait for the timeout when the approver answers first', async () => {
    const { tool } = deployTool();
    const { clock, expire } = fakeClock();

    // `expire` is never called before the assertion. If the gate awaited the
    // sleep rather than racing it, this test would hang rather than fail —
    // which is exactly the bug a five-minute default would hide in production.
    await expect(
      callTool(withApproval(tool, autoApprove), { environment: 'staging' }, { clock }),
    ).resolves.toBe('deployed to staging');

    expire();
  });
});

describe('denyAll', () => {
  it('is honest wiring for a host with nobody to ask', async () => {
    const { tool, effect } = deployTool();

    await expect(
      callTool(withApproval(tool, denyAll), { environment: 'production' }),
    ).rejects.toThrow(/no way to ask anyone/);
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('withApprovalAll', () => {
  it('gates only the tools that asked to be gated', async () => {
    const { tool: deploy } = deployTool();
    const read = defineTool({
      name: 'fs.read',
      description: 'Read a UTF-8 text file from disk.',
      execute: () => Promise.resolve('contents'),
    });

    const [gatedDeploy, gatedRead] = withApprovalAll([deploy, read], denyAll);

    expect(gatedRead).toBe(read);
    await expect(
      callTool(gatedDeploy as typeof deploy, { environment: 'production' }),
    ).rejects.toThrow(ApprovalDeniedError);
  });
});

describe('guard', () => {
  // The ordering that matters: an operator should never be asked to approve a
  // call that a missing grant was going to refuse anyway.
  it('refuses a missing permission without troubling anyone', async () => {
    const { tool, effect } = deployTool();
    const approver = vi.fn(autoApprove);

    await expect(
      callTool(guard(tool, PermissionSet.none(), approver), {
        environment: 'production',
      }),
    ).rejects.toThrow(PermissionDeniedError);

    expect(approver).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it('asks for approval once the grant is there', async () => {
    const { tool, effect } = deployTool();
    const approver = vi.fn(autoApprove);

    const result = await callTool(
      guard(tool, new PermissionSet(['deploy:prod']), approver),
      { environment: 'production' },
    );

    expect(result).toBe('deployed to production');
    expect(approver).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledWith('production');
  });

  it('still refuses a denied call that was fully permitted', async () => {
    const { tool, effect } = deployTool();

    await expect(
      callTool(guard(tool, PermissionSet.all(), denyAll), {
        environment: 'production',
      }),
    ).rejects.toThrow(ApprovalDeniedError);
    expect(effect).not.toHaveBeenCalled();
  });
});
