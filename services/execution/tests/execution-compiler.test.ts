/**
 * The execution compiler and the step envelope's contract.
 *
 * Pure: a plan in, a `MissionSpec` out. The interesting claims are that the
 * kernel's vocabulary is preserved exactly (ordering, priorities, budgets) while
 * the handler is swapped for the envelope — because the whole design rests on
 * the kernel still doing everything it did before.
 */

import { describe, expect, it } from 'vitest';
import { compileExecution } from '../src/compiler/execution-compiler.js';
import { STEP_AGENT_NAME, type StepEnvelope } from '../src/compiler/step-envelope.js';
import { InvalidReferenceError } from '../src/errors.js';
import { plan, step } from './helpers/fixtures.js';

const compile = (p: Parameters<typeof compileExecution>[0], options = {}) =>
  compileExecution(p, { executionId: 'exec_1', ...options });

describe('compileExecution', () => {
  it('wraps every step in the envelope agent', () => {
    const spec = compile(plan([step('a'), step('b', { dependsOn: ['a'] })]));

    expect(spec.tasks.map((task) => task.handler)).toEqual([
      { kind: 'agent', name: STEP_AGENT_NAME },
      { kind: 'agent', name: STEP_AGENT_NAME },
    ]);
  });

  it('puts the real capability and the execution id in the envelope', () => {
    const spec = compile(plan([step('a', { input: { x: 1 } })]));

    expect(spec.tasks[0]?.input).toEqual({
      executionId: 'exec_1',
      step: 'a',
      capability: { kind: 'tool', name: 'echo' },
      input: { x: 1 },
    } satisfies StepEnvelope);
  });

  it('omits input from the envelope when the step has none', () => {
    const spec = compile(plan([step('a')]));

    expect(spec.tasks[0]?.input).not.toHaveProperty('input');
  });

  // The kernel still orders the graph. Losing this would mean the engine had
  // quietly become a scheduler.
  it('preserves dependsOn, so the kernel still orders the graph', () => {
    const spec = compile(plan([step('a'), step('b', { dependsOn: ['a'] })]));

    expect(spec.tasks[1]?.dependsOn).toEqual(['a']);
  });

  it('preserves the scheduling knobs the kernel owns', () => {
    const spec = compile(
      plan([step('a', { priority: 5, maxAttempts: 3, timeoutMs: 1_000 })]),
    );

    expect(spec.tasks[0]).toMatchObject({
      priority: 5,
      maxAttempts: 3,
      timeoutMs: 1_000,
    });
  });

  it('omits a knob the step did not set, leaving the kernel default', () => {
    const spec = compile(plan([step('a')]));

    expect(spec.tasks[0]).not.toHaveProperty('priority');
    expect(spec.tasks[0]).not.toHaveProperty('timeoutMs');
  });

  it('carries the goal and the failure policy onto the mission', () => {
    const spec = compile(
      plan([step('a')], {
        goal: { statement: 'Summarise my day', failurePolicy: 'continue' },
      }),
    );

    expect(spec.goal).toBe('Summarise my day');
    expect(spec.failurePolicy).toBe('continue');
  });

  it('names the mission after the goal by default', () => {
    expect(compile(plan([step('a')])).name).toBe('do-the-thing');
  });

  it('takes an explicit name over the slug', () => {
    expect(compile(plan([step('a')]), { name: 'nightly' }).name).toBe('nightly');
  });

  // The mitigation for the design's one real cost: the kernel's handler says
  // `hermes.step`, so without these the audit log could not say what ran.
  it('records the real capability and intent in task metadata', () => {
    const spec = compile(plan([step('a')]));

    expect(spec.tasks[0]?.metadata).toMatchObject({
      intent: 'Do a',
      capability: 'tool:echo',
    });
  });

  it('records which plan produced the mission', () => {
    const spec = compile(plan([step('a')]));

    expect(spec.metadata).toMatchObject({ planId: 'plan_test', strategy: 'test' });
  });

  // The audit log's account of which plan produced a mission has to be
  // trustworthy, so a caller cannot overwrite it.
  it('does not let caller metadata overwrite the engine provenance', () => {
    const spec = compile(plan([step('a')]), {
      metadata: { planId: 'lies', mine: true },
    });

    expect(spec.metadata).toMatchObject({ planId: 'plan_test', mine: true });
  });

  it('carries the memory subject when the goal names one', () => {
    const spec = compile(
      plan([step('a')], { goal: { statement: 'x', subject: 'ada' } }),
    );

    expect(spec.metadata).toMatchObject({ subject: 'ada' });
  });
});

describe('excluding steps that already succeeded', () => {
  it('leaves them out of the mission', () => {
    const spec = compile(plan([step('a'), step('b', { dependsOn: ['a'] })]), {
      exclude: ['a'],
    });

    expect(spec.tasks.map((task) => task.name)).toEqual(['b']);
  });

  // The dependency is satisfied — that is what "succeeded" means — and a
  // surviving edge would name a task the mission does not contain, which the
  // kernel rejects outright.
  it('drops a dependency on an excluded step, because it is satisfied', () => {
    const spec = compile(plan([step('a'), step('b', { dependsOn: ['a'] })]), {
      exclude: ['a'],
    });

    expect(spec.tasks[0]?.dependsOn).toEqual([]);
  });

  it('keeps a dependency between two surviving steps', () => {
    const spec = compile(
      plan([
        step('a'),
        step('b', { dependsOn: ['a'] }),
        step('c', { dependsOn: ['b'] }),
      ]),
      { exclude: ['a'] },
    );

    expect(spec.tasks[1]?.dependsOn).toEqual(['b']);
  });

  // A resume legitimately references an excluded step: the value is in the
  // context. Validating only what runs would reject a correct resume.
  it('still accepts a reference into an excluded step', () => {
    expect(() =>
      compile(
        plan([
          step('a'),
          step('b', { dependsOn: ['a'], input: { x: { $from: 'a' } } }),
        ]),
        { exclude: ['a'] },
      ),
    ).not.toThrow();
  });
});

describe('reference validation', () => {
  it('rejects a reference that is not a declared dependency', () => {
    expect(() =>
      compile(plan([step('a'), step('b', { input: { x: { $from: 'a' } } })])),
    ).toThrow(InvalidReferenceError);
  });

  it('rejects a reference to a step that does not exist', () => {
    expect(() =>
      compile(
        plan([step('b', { dependsOn: ['ghost'], input: { x: { $from: 'ghost' } } })]),
      ),
    ).toThrow(/no such step is in the plan/);
  });
});
