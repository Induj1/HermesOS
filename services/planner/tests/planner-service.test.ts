/**
 * PlannerService behaviour — the composition root.
 *
 * The interesting claims here are about the *chain*: that it takes the first
 * valid plan, that a strategy which throws degrades to the next one rather than
 * to an unhandled rejection, and that an abort stops it. Those are the promises
 * the module header makes, so they are what these tests hold it to.
 *
 * Strategies are hand-written stubs rather than mocks: a strategy is a one-method
 * interface, and a stub that returns a plan states the scenario more plainly than
 * a mock framework configuring one to.
 */

import { describe, expect, it, vi } from 'vitest';
import { sequentialIds } from '@hermes/kernel';
import { PlannerService } from '../src/planner-service.js';
import {
  InvalidInputError,
  PlanningFailedError,
  PlanValidationError,
} from '../src/errors.js';
import type { Goal, Plan, PlanStep } from '../src/model.js';
import type { PlanContext, PlanStrategy } from '../src/ports/plan-strategy.js';
import { buildPlan } from '../src/ports/plan-strategy.js';
import {
  catalogOf,
  context,
  missionSnapshot,
  recordingLogger,
  step,
  taskSnapshot,
} from './helpers/fixtures.js';

/** A strategy that always proposes the given steps. */
function proposing(name: string, steps: readonly PlanStep[]): PlanStrategy {
  return {
    name,
    propose: (goal: Goal, ctx: PlanContext): Promise<Plan> =>
      Promise.resolve(
        buildPlan(name, goal, steps, ctx, { rationale: `${name} says so` }),
      ),
  };
}

/** A strategy that always declines — "this goal is not mine". */
function declining(name: string): PlanStrategy {
  return { name, propose: (): Promise<undefined> => Promise.resolve(undefined) };
}

/** A strategy that is broken, as a model-backed one is when the network is out. */
function throwing(name: string, message = 'model is down'): PlanStrategy {
  return {
    name,
    propose: (): Promise<never> => Promise.reject(new Error(message)),
  };
}

function service(
  strategies: readonly PlanStrategy[],
  options: {
    catalog?: ReturnType<typeof catalogOf>;
    logger?: PlanContext['logger'];
  } = {},
): PlannerService {
  return new PlannerService({
    strategies,
    catalog: options.catalog ?? catalogOf('tool.a', 'tool.b'),
    clock: context().clock,
    ids: sequentialIds(),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

describe('PlannerService construction', () => {
  it('rejects an empty chain at construction, not at the first goal', () => {
    // A planner that can never plan is a wiring mistake; it should fail where the
    // wiring is rather than hours later in production.
    expect(() => service([])).toThrow(InvalidInputError);
  });

  it('exposes the chain in the order it will be tried', () => {
    const first = declining('first');
    const second = proposing('second', [step('a')]);

    expect(service([first, second]).strategies).toEqual([first, second]);
  });

  // A host that wants the defaults should not have to name a clock, a logger and
  // an id generator to get them. Everything but the chain and the catalog is
  // optional, and this is the only test that runs on the real ones.
  it('runs on real defaults when given only a chain and a catalog', async () => {
    const planner = new PlannerService({
      strategies: [proposing('template', [step('a')])],
      catalog: catalogOf('tool.a'),
    });

    const before = Date.now();
    const { plan } = await planner.plan({ statement: 'Do the thing' });

    // The default clock is the system one, and the default ids are random.
    expect(plan.createdAt).toBeGreaterThanOrEqual(before);
    expect(plan.id).toMatch(/^plan_/);
  });

  it('mints a distinct id for every plan under the default id generator', async () => {
    const planner = new PlannerService({
      strategies: [proposing('template', [step('a')])],
      catalog: catalogOf('tool.a'),
    });

    const first = await planner.plan({ statement: 'Do the thing' });
    const second = await planner.plan({ statement: 'Do the thing' });

    expect(first.plan.id).not.toBe(second.plan.id);
  });
});

describe('PlannerService.plan', () => {
  it('returns the plan from the first strategy that produces a valid one', async () => {
    const result = await service([proposing('template', [step('a')])]).plan({
      statement: 'Do the thing',
    });

    expect(result.plan.strategy).toBe('template');
    expect(result.plan.steps.map((s) => s.name)).toEqual(['a']);
  });

  it('skips a strategy that declines and uses the next', async () => {
    const result = await service([
      declining('llm'),
      proposing('template', [step('a')]),
    ]).plan({
      statement: 'Do the thing',
    });

    expect(result.plan.strategy).toBe('template');
  });

  it('records every attempt, in the order tried', async () => {
    const result = await service([
      declining('llm'),
      throwing('remote'),
      proposing('template', [step('a')]),
    ]).plan({ statement: 'Do the thing' });

    expect(result.attempts).toEqual([
      { strategy: 'llm', outcome: 'declined' },
      { strategy: 'remote', outcome: 'threw', reason: 'model is down' },
      { strategy: 'template', outcome: 'accepted' },
    ]);
  });

  it('takes the first valid plan rather than the most confident one', async () => {
    const timid: PlanStrategy = {
      name: 'timid',
      propose: (goal, ctx) =>
        Promise.resolve(
          buildPlan('timid', goal, [step('a')], ctx, {
            rationale: 'unsure',
            confidence: 0.1,
          }),
        ),
    };
    const bold: PlanStrategy = {
      name: 'bold',
      propose: (goal, ctx) =>
        Promise.resolve(
          buildPlan('bold', goal, [step('b')], ctx, {
            rationale: 'certain',
            confidence: 1,
          }),
        ),
    };

    // Confidence is a strategy's report about itself; ranking by it would let a
    // strategy that overstates it win every race it should lose. Order is policy.
    const result = await service([timid, bold]).plan({ statement: 'Do the thing' });

    expect(result.plan.strategy).toBe('timid');
  });

  it('stops at the first valid plan and does not consult later strategies', async () => {
    const later = { name: 'later', propose: vi.fn() };

    await service([proposing('template', [step('a')]), later]).plan({
      statement: 'Do it',
    });

    expect(later.propose).not.toHaveBeenCalled();
  });

  // The whole of "if AI fails, fall back to deterministic behaviour": no circuit
  // breaker, no health check — the broken strategy throws and the next answers.
  it('degrades to the next strategy when one throws, rather than rejecting', async () => {
    const result = await service([
      throwing('llm'),
      proposing('template', [step('a')]),
    ]).plan({
      statement: 'Do the thing',
    });

    expect(result.plan.strategy).toBe('template');
  });

  it('treats a strategy throwing a non-Error as a normal fall-through', async () => {
    const rude: PlanStrategy = {
      name: 'rude',
      // Rejecting with a non-Error is the scenario under test, not an oversight:
      // a third-party strategy is not obliged to be well-behaved, and the chain
      // must survive one that is not.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
      propose: () => Promise.reject('just a string'),
    };

    const result = await service([rude, proposing('template', [step('a')])]).plan({
      statement: 'Do the thing',
    });

    expect(result.plan.strategy).toBe('template');
    expect(result.attempts[0]).toMatchObject({ strategy: 'rude', outcome: 'threw' });
  });

  it('rejects a proposal naming a capability the runtime does not have', async () => {
    const result = await service([
      proposing('llm', [
        step('a', { capability: { kind: 'tool', name: 'tool.imaginary' } }),
      ]),
      proposing('template', [step('a')]),
    ]).plan({ statement: 'Do the thing' });

    // The kernel would have accepted this mission and only failed at dispatch,
    // after running everything upstream of it for real. See kernel-gap.test.ts.
    expect(result.plan.strategy).toBe('template');
    expect(result.attempts[0]).toMatchObject({ outcome: 'invalid' });
    expect(result.attempts[0]?.reason).toContain('tool.imaginary');
  });

  it('drops an optional step whose capability is missing and reports it', async () => {
    const result = await service([
      proposing('template', [
        step('a'),
        step('extra', {
          capability: { kind: 'tool', name: 'tool.imaginary' },
          optional: true,
        }),
      ]),
    ]).plan({ statement: 'Do the thing' });

    expect(result.plan.steps.map((s) => s.name)).toEqual(['a']);
    expect(result.dropped).toEqual([
      {
        name: 'extra',
        reason: 'optional step dropped: tool "tool.imaginary" is not registered',
      },
    ]);
  });

  it('throws PlanningFailedError carrying the whole chain when nothing works', async () => {
    const promise = service([declining('llm'), throwing('remote')]).plan({
      statement: 'Do the thing',
    });

    await expect(promise).rejects.toThrow(PlanningFailedError);
    // "Planning failed" alone makes a five-strategy chain undebuggable.
    await expect(promise).rejects.toMatchObject({
      attempts: [
        { strategy: 'llm', outcome: 'declined' },
        { strategy: 'remote', outcome: 'threw', reason: 'model is down' },
      ],
    });
  });

  it('rejects an empty goal statement at the boundary', async () => {
    await expect(
      service([proposing('template', [step('a')])]).plan({ statement: '   ' }),
    ).rejects.toThrow(InvalidInputError);
  });

  it.each([
    ['maxSteps', { maxSteps: 0 }],
    ['maxDepth', { maxDepth: 0 }],
  ])('rejects a nonsensical %s constraint', async (_label, constraints) => {
    await expect(
      service([proposing('template', [step('a')])]).plan({
        statement: 'Do it',
        constraints,
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('keeps the abort signal off the goal a strategy receives', async () => {
    let seen: Goal | undefined;
    const spy: PlanStrategy = {
      name: 'spy',
      propose: (goal, ctx) => {
        seen = goal;
        return Promise.resolve(
          buildPlan('spy', goal, [step('a')], ctx, { rationale: 'ok' }),
        );
      },
    };

    await service([spy]).plan({
      statement: 'Do it',
      signal: new AbortController().signal,
    });

    // The goal is carried onto the plan and compiled into mission metadata, so it
    // must stay plain serialisable data.
    expect(seen && 'signal' in seen).toBe(false);
  });

  it('aborts before running any strategy when the signal is already aborted', async () => {
    const never = { name: 'never', propose: vi.fn() };

    await expect(
      service([never]).plan({ statement: 'Do it', signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(never.propose).not.toHaveBeenCalled();
  });

  it('stops the chain when the caller aborts partway through', async () => {
    const controller = new AbortController();
    const second = { name: 'second', propose: vi.fn() };
    const aborting: PlanStrategy = {
      name: 'aborting',
      propose: () => {
        controller.abort();
        return Promise.resolve(undefined);
      },
    };

    await expect(
      service([aborting, second]).plan({
        statement: 'Do it',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    // A chain of five must not run the remaining four after the caller has gone.
    expect(second.propose).not.toHaveBeenCalled();
  });

  it('propagates an abort rather than blaming the strategy that noticed it', async () => {
    const controller = new AbortController();
    const aborting: PlanStrategy = {
      name: 'aborting',
      propose: () => {
        controller.abort();
        return Promise.reject(new Error('aborted'));
      },
    };
    const fallback = { name: 'fallback', propose: vi.fn() };

    await expect(
      service([aborting, fallback]).plan({
        statement: 'Do it',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    // Falling through here would ignore the abort entirely.
    expect(fallback.propose).not.toHaveBeenCalled();
  });

  it('reports what it planned', async () => {
    const { logger, messages } = recordingLogger();

    await service([proposing('template', [step('a')])], { logger }).plan({
      statement: 'Do it',
    });

    expect(messages).toContainEqual({ level: 'info', message: 'Planned' });
  });

  it('warns when the whole chain came up empty', async () => {
    const { logger, messages } = recordingLogger();

    await expect(
      service([declining('llm')], { logger }).plan({ statement: 'Do it' }),
    ).rejects.toThrow();

    expect(messages).toContainEqual({
      level: 'warn',
      message: 'No strategy produced a valid plan',
    });
  });
});

describe('PlannerService.compile', () => {
  it('projects a plan onto a MissionSpec the kernel accepts', async () => {
    const planner = service([
      proposing('template', [step('a'), step('b', { dependsOn: ['a'] })]),
    ]);
    const { plan } = await planner.plan({ statement: 'Do the thing' });

    const spec = planner.compile(plan);

    expect(spec.goal).toBe('Do the thing');
    expect(spec.tasks.map((task) => task.name)).toEqual(['a', 'b']);
    expect(spec.tasks[1]?.dependsOn).toEqual(['a']);
  });

  it('plans and compiles in one step for a host that does not want to inspect', async () => {
    const spec = await service([proposing('template', [step('a')])]).planMission({
      statement: 'Do the thing',
    });

    expect(spec.tasks.map((task) => task.name)).toEqual(['a']);
  });
});

describe('PlannerService.replan', () => {
  it('builds a plan for the unfinished part of a mission', () => {
    const planner = service([proposing('template', [step('a')])]);
    const snapshot = missionSnapshot([
      taskSnapshot('a', 'succeeded', { handler: { kind: 'tool', name: 'tool.a' } }),
      taskSnapshot('b', 'failed', { handler: { kind: 'tool', name: 'tool.b' } }),
    ]);

    const plan = planner.replan(snapshot, { incomplete: 'fail' });

    expect(plan.steps.map((s) => s.name)).toEqual(['b']);
  });

  it('rejects a replan whose capability has since been unregistered', () => {
    const planner = service([proposing('template', [step('a')])], {
      catalog: catalogOf('tool.a'),
    });
    const snapshot = missionSnapshot([
      taskSnapshot('gone', 'failed', {
        handler: { kind: 'tool', name: 'tool.removed' },
      }),
    ]);

    // Better here than at dispatch, after the upstream half has run for real.
    expect(() => planner.replan(snapshot, { incomplete: 'fail' })).toThrow(
      PlanValidationError,
    );
  });
});
