/**
 * Replanner behaviour.
 *
 * These tests are about *what a replan carries*, which is the only question the
 * replanner exists to answer. They assert on the plan it produces rather than on
 * how it walks the snapshot, so the traversal can be rewritten without touching
 * a test — which is exactly what happened when the `skip` transitivity bug was
 * fixed.
 */

import { describe, expect, it } from 'vitest';
import { Replanner } from '../src/replan/replanner.js';
import { NothingToReplanError } from '../src/errors.js';
import { context, goal, missionSnapshot, taskSnapshot } from './helpers/fixtures.js';

const replanner = (): Replanner => new Replanner(context());

/** Step names in the produced plan, which is what most of these assert on. */
const names = (steps: readonly { name: string }[]): string[] =>
  steps.map((step) => step.name);

describe('Replanner.analyse', () => {
  it('leaves succeeded tasks behind and carries the unfinished ones', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('fetch', 'succeeded'),
      taskSnapshot('render', 'failed'),
    ]);

    const analysis = replanner().analyse(snapshot, { incomplete: 'fail' });

    expect(analysis.completed).toEqual(['fetch']);
    expect(analysis.resume).toEqual(['render']);
    expect(analysis.abandoned).toEqual([]);
    expect(analysis.missionId).toBe(snapshot.id);
  });

  it('carries succeeded tasks too when asked for a rebuild', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('fetch', 'succeeded'),
      taskSnapshot('render', 'failed'),
    ]);

    const analysis = replanner().analyse(snapshot, {
      incomplete: 'fail',
      includeSucceeded: true,
    });

    expect(analysis.resume).toEqual(['fetch', 'render']);
    expect(analysis.completed).toEqual([]);
  });

  // `skipped` means an upstream dependency did not succeed, so the task never
  // ran. It is outstanding work, not a fate — see the RESUMABLE comment.
  it.each(['failed', 'skipped', 'pending', 'cancelled'] as const)(
    'treats a %s task as outstanding work',
    (state) => {
      const snapshot = missionSnapshot([taskSnapshot('step', state)]);

      expect(replanner().analyse(snapshot, { incomplete: 'fail' }).resume).toEqual([
        'step',
      ]);
    },
  );

  it.each(['running', 'ready'] as const)(
    'carries a %s task under the retry policy',
    (state) => {
      const snapshot = missionSnapshot([taskSnapshot('send', state)]);

      expect(replanner().analyse(snapshot, { incomplete: 'retry' }).resume).toEqual([
        'send',
      ]);
    },
  );

  it.each(['running', 'ready'] as const)(
    'abandons a %s task under the skip policy',
    (state) => {
      const snapshot = missionSnapshot([taskSnapshot('send', state)]);

      const analysis = replanner().analyse(snapshot, { incomplete: 'skip' });

      expect(analysis.resume).toEqual([]);
      expect(analysis.abandoned).toEqual([{ name: 'send', state }]);
    },
  );
});

describe('Replanner.replan', () => {
  it('drops dependencies that already succeeded, because they are satisfied', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('fetch', 'succeeded'),
      taskSnapshot('render', 'failed', { dependsOn: ['fetch'] }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    // A surviving `dependsOn: ['fetch']` would name a task the new mission does
    // not contain, and the kernel would reject the whole spec.
    expect(names(plan.steps)).toEqual(['render']);
    expect(plan.steps[0]?.dependsOn).toEqual([]);
  });

  it('preserves dependencies between two carried steps', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('fetch', 'failed'),
      taskSnapshot('render', 'skipped', { dependsOn: ['fetch'] }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(names(plan.steps)).toEqual(['fetch', 'render']);
    expect(plan.steps[1]?.dependsOn).toEqual(['fetch']);
  });

  // The dangerous case, and the reason `skip` exists at all. Skipping a
  // mid-flight payment must not promote "send receipt" into a step that runs
  // with no prerequisite — dropping the *edge* would do exactly that.
  it('drops the dependents of a skipped task rather than orphaning them', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('send-receipt', 'pending', { dependsOn: ['charge-card'] }),
      taskSnapshot('unrelated', 'failed'),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'skip' });

    // The edge cannot merely be dropped: that would leave send-receipt with no
    // prerequisite at all, so it would run immediately for a payment that may
    // never have happened.
    expect(names(plan.steps)).not.toContain('send-receipt');
    expect(names(plan.steps)).toEqual(['unrelated']);
  });

  it('poisons a carried succeeded step under includeSucceeded when its dependency is skipped', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('send-receipt', 'succeeded', { dependsOn: ['charge-card'] }),
      taskSnapshot('unrelated', 'failed'),
    ]);

    const plan = replanner().replan(snapshot, {
      incomplete: 'skip',
      includeSucceeded: true,
    });

    // includeSucceeded means it would run *again*, and its prerequisite will not.
    expect(names(plan.steps)).toEqual(['unrelated']);
  });

  it('stops propagating at a succeeded step, whose dependents are genuinely free to run', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('send-receipt', 'succeeded', { dependsOn: ['charge-card'] }),
      taskSnapshot('log-receipt', 'failed', { dependsOn: ['send-receipt'] }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'skip' });

    // send-receipt succeeded, so log-receipt's prerequisite is satisfied: the
    // chain is broken there and the skip does not reach further.
    expect(names(plan.steps)).toEqual(['log-receipt']);
  });

  it('drops dependents of a skipped task transitively', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('send-receipt', 'pending', { dependsOn: ['charge-card'] }),
      taskSnapshot('log-receipt', 'pending', { dependsOn: ['send-receipt'] }),
      taskSnapshot('unrelated', 'failed'),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'skip' });

    // Only the step with no path to the skipped task survives.
    expect(names(plan.steps)).toEqual(['unrelated']);
  });

  it('reports transitively abandoned steps in the analysis', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('send-receipt', 'pending', { dependsOn: ['charge-card'] }),
    ]);

    const analysis = replanner().analyse(snapshot, { incomplete: 'skip' });

    expect(analysis.abandoned).toEqual([
      { name: 'charge-card', state: 'running' },
      { name: 'send-receipt', state: 'pending' },
    ]);
    expect(analysis.resume).toEqual([]);
  });

  it('keeps a step whose skipped dependency is not on its path', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('fetch', 'failed'),
      taskSnapshot('render', 'pending', { dependsOn: ['fetch'] }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'skip' });

    expect(names(plan.steps)).toEqual(['fetch', 'render']);
  });

  it('refuses to replan a mid-flight mission under the fail policy', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('render', 'failed'),
    ]);

    expect(() => replanner().replan(snapshot, { incomplete: 'fail' })).toThrow(
      NothingToReplanError,
    );
  });

  it('names the mid-flight tasks when it refuses, so a human knows where to look', () => {
    const snapshot = missionSnapshot([taskSnapshot('charge-card', 'running')]);

    expect(() => replanner().replan(snapshot, { incomplete: 'fail' })).toThrow(
      /charge-card/,
    );
  });

  it('throws when every task already succeeded', () => {
    const snapshot = missionSnapshot([taskSnapshot('fetch', 'succeeded')], {
      state: 'succeeded',
    });

    expect(() => replanner().replan(snapshot, { incomplete: 'fail' })).toThrow(
      NothingToReplanError,
    );
    expect(() => replanner().replan(snapshot, { incomplete: 'fail' })).toThrow(
      /every task already succeeded/,
    );
  });

  // A mission emptied by a `skip` is not a mission that is done, and a caller
  // told "every task succeeded" would go looking in entirely the wrong place.
  it('distinguishes a mission emptied by skip from one that simply finished', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('send', 'running'),
      taskSnapshot('confirm', 'pending', { dependsOn: ['send'] }),
    ]);

    expect(() => replanner().replan(snapshot, { incomplete: 'skip' })).toThrow(
      /2 were abandoned under the "skip" policy/,
    );
  });

  it('recovers each step intent from the metadata the compiler wrote', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('render', 'failed', {
        metadata: { intent: 'Render the daily brief' },
      }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.steps[0]?.intent).toBe('Render the daily brief');
  });

  it('gives an honest placeholder intent for a hand-authored mission', () => {
    const snapshot = missionSnapshot([taskSnapshot('render', 'failed')]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    // Not a fabricated rationale: it says only what the snapshot actually knows.
    expect(plan.steps[0]?.intent).toBe('Re-run task "render" (tool "tool.render")');
  });

  it('records where each carried step came from, for the audit log', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('render', 'failed', { attempts: 3 }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.steps[0]?.metadata).toMatchObject({
      replannedFrom: snapshot.id,
      previousState: 'failed',
      previousAttempts: 3,
    });
  });

  it('carries the handler, input, priority and attempt budget unchanged', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('render', 'failed', {
        handler: { kind: 'agent', name: 'summariser' },
        input: { format: 'markdown' },
        priority: 7,
        maxAttempts: 4,
      }),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.steps[0]).toMatchObject({
      capability: { kind: 'agent', name: 'summariser' },
      input: { format: 'markdown' },
      priority: 7,
      maxAttempts: 4,
    });
  });

  it('omits input entirely when the task had none, rather than writing undefined', () => {
    const snapshot = missionSnapshot([taskSnapshot('render', 'failed')]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.steps[0] && 'input' in plan.steps[0]).toBe(false);
  });

  it('reconstructs the goal from the snapshot, including the memory subject', () => {
    const snapshot = missionSnapshot([taskSnapshot('render', 'failed')], {
      goal: 'Summarise my day',
      metadata: { subject: 'ada' },
      failurePolicy: 'continue',
    });

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.goal).toEqual({
      statement: 'Summarise my day',
      subject: 'ada',
      failurePolicy: 'continue',
    });
  });

  it('falls back to the mission name when the mission recorded no goal', () => {
    const snapshot = missionSnapshot([taskSnapshot('render', 'failed')], {
      goal: undefined,
      name: 'nightly-build',
    });

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.goal.statement).toBe('Complete mission "nightly-build"');
  });

  it('prefers a caller-supplied goal over the reconstructed one', () => {
    const snapshot = missionSnapshot([taskSnapshot('render', 'failed')]);
    const override = goal('Try again, but for Ada', { subject: 'ada' });

    const plan = replanner().replan(snapshot, { incomplete: 'fail', goal: override });

    expect(plan.goal).toEqual(override);
  });

  it('marks the plan as a replan and records the policy that produced it', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('charge-card', 'running'),
      taskSnapshot('render', 'failed'),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'skip' });

    expect(plan.strategy).toBe('replan');
    expect(plan.confidence).toBe(1);
    expect(plan.metadata).toMatchObject({
      replannedFrom: snapshot.id,
      incompletePolicy: 'skip',
      abandoned: ['charge-card'],
    });
  });

  it('explains itself in the rationale', () => {
    const snapshot = missionSnapshot([
      taskSnapshot('fetch', 'succeeded'),
      taskSnapshot('render', 'failed'),
    ]);

    const plan = replanner().replan(snapshot, { incomplete: 'fail' });

    expect(plan.rationale).toContain('test-mission');
    expect(plan.rationale).toContain('1 unfinished step');
  });
});
