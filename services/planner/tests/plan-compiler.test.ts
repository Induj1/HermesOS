/**
 * The compiler: Plan -> MissionSpec.
 *
 * The assertions that matter are about *lossiness*: the kernel refuses to know
 * why work exists, so the planner's vocabulary has to survive the projection
 * through `metadata` — the one field the kernel carries and never interprets.
 * Several tests then feed the output to the real `Mission.create`, because a spec
 * the kernel rejects is not a compiled plan, it is a bug.
 */

import { describe, expect, it } from 'vitest';
import { Mission, sequentialIds } from '@hermes/kernel';
import { compilePlan, slugify } from '../src/compiler/plan-compiler.js';
import { goal, plan, step, FIXED_NOW } from './helpers/fixtures.js';
import { toPlanId } from '../src/model.js';

/** Build the compiled spec through the kernel, proving it is actually acceptable. */
function throughKernel(spec: Parameters<typeof Mission.create>[0]): Mission {
  return Mission.create(spec, { ids: sequentialIds(), now: FIXED_NOW });
}

describe('compilePlan', () => {
  it('maps steps to tasks', () => {
    const spec = compilePlan(plan([step('a'), step('b', { dependsOn: ['a'] })]));

    expect(spec.tasks).toHaveLength(2);
    expect(spec.tasks[0]).toMatchObject({
      name: 'a',
      handler: { kind: 'tool', name: 'tool.a' },
    });
    expect(spec.tasks[1]?.dependsOn).toEqual(['a']);
  });

  it('carries the goal statement into the kernel field built for it', () => {
    // MissionSpec.goal is "Human-readable statement of intent. Carried, never
    // interpreted" — exactly what a natural-language statement needs.
    const spec = compilePlan(plan([step('a')], { goal: goal('Summarise my day') }));
    expect(spec.goal).toBe('Summarise my day');
  });

  it('produces a spec the kernel accepts', () => {
    const spec = compilePlan(
      plan([
        step('a'),
        step('b', { dependsOn: ['a'], maxAttempts: 3, timeoutMs: 1000 }),
      ]),
    );
    expect(() => throughKernel(spec)).not.toThrow();
  });

  describe('provenance — surviving a lossy projection', () => {
    it('records which plan, strategy, and rationale produced the mission', () => {
      // "Why did this mission run, and what decided that?" must be answerable from
      // the mission alone, months later.
      const spec = compilePlan(
        plan([step('a')], {
          id: toPlanId('plan_7'),
          strategy: 'template',
          rationale: 'Matched the brief template',
          confidence: 0.8,
        }),
      );

      expect(spec.metadata).toMatchObject({
        planId: 'plan_7',
        planStrategy: 'template',
        planRationale: 'Matched the brief template',
        planConfidence: 0.8,
        plannedAt: FIXED_NOW,
      });
    });

    it('carries each step intent into its task metadata', () => {
      // The only thing that explains a plan to someone who did not write it. It
      // has to survive, and the kernel's never-interpreted metadata is the channel.
      const spec = compilePlan(plan([step('a', { intent: 'Fetch the calendar' })]));
      expect(spec.tasks[0]?.metadata?.['intent']).toBe('Fetch the calendar');
    });

    it('carries the subject when the goal has one', () => {
      const spec = compilePlan(
        plan([step('a')], { goal: goal('x', { subject: 'ada' }) }),
      );
      expect(spec.metadata?.['subject']).toBe('ada');
    });

    it('omits the subject rather than writing undefined', () => {
      const spec = compilePlan(plan([step('a')]));
      expect(spec.metadata && 'subject' in spec.metadata).toBe(false);
    });

    it('marks an optional step so a reader knows it could have been dropped', () => {
      const spec = compilePlan(plan([step('a', { optional: true })]));
      expect(spec.tasks[0]?.metadata?.['optional']).toBe(true);
    });

    it('lets a host override compiled metadata', () => {
      const spec = compilePlan(plan([step('a')]), {
        metadata: { planStrategy: 'mine' },
      });
      expect(spec.metadata?.['planStrategy']).toBe('mine');
    });
  });

  describe('optional fields', () => {
    it('omits absent scheduling hints so the kernel defaults apply', () => {
      // exactOptionalPropertyTypes is on: "the planner said nothing" must reach
      // the kernel as silence, not as an explicit undefined.
      const spec = compilePlan(plan([step('a')]));
      const task = spec.tasks[0];

      expect(task && 'input' in task).toBe(false);
      expect(task && 'priority' in task).toBe(false);
      expect(task && 'maxAttempts' in task).toBe(false);
      expect(task && 'timeoutMs' in task).toBe(false);
    });

    it('passes scheduling hints through when present', () => {
      const spec = compilePlan(
        plan([
          step('a', { priority: 5, maxAttempts: 3, timeoutMs: 100, input: { x: 1 } }),
        ]),
      );
      expect(spec.tasks[0]).toMatchObject({
        priority: 5,
        maxAttempts: 3,
        timeoutMs: 100,
        input: { x: 1 },
      });
    });

    it('passes the failure policy through', () => {
      const spec = compilePlan(
        plan([step('a')], { goal: goal('x', { failurePolicy: 'continue' }) }),
      );
      expect(spec.failurePolicy).toBe('continue');
    });

    it('omits the failure policy so the kernel default applies', () => {
      const spec = compilePlan(plan([step('a')]));
      expect('failurePolicy' in spec).toBe(false);
      // And the kernel's own default is what takes over.
      expect(throughKernel(spec).failurePolicy).toBe('fail-fast');
    });

    it('compiles an agent capability to an agent handler', () => {
      const spec = compilePlan(
        plan([step('a', { capability: { kind: 'agent', name: 'summariser' } })]),
      );
      expect(spec.tasks[0]?.handler).toEqual({ kind: 'agent', name: 'summariser' });
    });
  });

  describe('naming', () => {
    it('slugifies the goal statement by default', () => {
      const spec = compilePlan(plan([step('a')], { goal: goal('Summarise My Day!') }));
      expect(spec.name).toBe('summarise-my-day');
    });

    it('takes an explicit name', () => {
      const spec = compilePlan(plan([step('a')]), { name: 'morning-brief' });
      expect(spec.name).toBe('morning-brief');
    });
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Summarise My Day')).toBe('summarise-my-day');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugify('what -- is  going on?!')).toBe('what-is-going-on');
  });

  it('strips combining marks rather than losing the word', () => {
    expect(slugify('café review')).toBe('cafe-review');
  });

  it('never ends in a hyphen, even when truncating', () => {
    // Truncation can land mid-separator; a trailing hyphen is ugly in every log
    // line that mission name ever appears in.
    expect(slugify(`${'a'.repeat(58)} bcdef`)).not.toMatch(/-$/);
  });

  it('caps the length', () => {
    expect(slugify('word '.repeat(50)).length).toBeLessThanOrEqual(60);
  });

  it('falls back rather than producing an empty name', () => {
    // The kernel rejects an empty mission name. A statement with no ASCII-able
    // characters would otherwise slug to "" and fail at Mission.create with a
    // message about names, not about encoding.
    expect(slugify('日本語')).toBe('mission');
    expect(slugify('!!!')).toBe('mission');
    expect(slugify('')).toBe('mission');
  });

  it('produces a name the kernel accepts, for any statement', () => {
    for (const statement of ['日本語', '!!!', '', 'a'.repeat(500), 'café ☕']) {
      const spec = compilePlan(plan([step('a')], { goal: goal(statement || 'x') }));
      expect(() => throughKernel({ ...spec, name: slugify(statement) })).not.toThrow();
    }
  });
});
