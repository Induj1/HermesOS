/**
 * Plan repair — dropping optional steps and rewiring what depended on them.
 *
 * Node contraction is the subtlest algorithm in this package, and the failure it
 * guards against is quiet: drop a step, forget to rewire, and you have traded a
 * missing capability for a broken graph. So this file includes property tests
 * alongside the examples — the invariants ("no dangling dependency ever", "order
 * is always preserved") are worth asserting over generated graphs, not just over
 * the four shapes I happened to think of.
 */

import { describe, expect, it } from 'vitest';
import { repairPlan } from '../src/validation/plan-repair.js';
import { PlanValidator } from '../src/validation/plan-validator.js';
import { StaticCapabilityCatalog } from '../src/ports/capability-catalog.js';
import type { Plan, PlanStep } from '../src/model.js';
import { capability, catalogOf, plan, step } from './helpers/fixtures.js';

/** Does `later` still run after `earlier`, transitively? */
function runsAfter(
  steps: readonly PlanStep[],
  later: string,
  earlier: string,
): boolean {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const seen = new Set<string>();

  const walk = (name: string): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const current = byName.get(name);
    if (!current) return false;
    const deps = current.dependsOn ?? [];
    return deps.includes(earlier) || deps.some(walk);
  };

  return walk(later);
}

function dependencyNames(steps: readonly PlanStep[]): readonly string[] {
  return steps.flatMap((s) => s.dependsOn ?? []);
}

describe('repairPlan', () => {
  describe('when nothing needs dropping', () => {
    it('returns the plan by identity', () => {
      // The common path should allocate nothing, and `result.plan === plan` is how
      // a caller cheaply learns that reality matched the proposal.
      const subject = plan([step('a')]);
      const result = repairPlan(subject, catalogOf('tool.a'));

      expect(result.plan).toBe(subject);
      expect(result.dropped).toEqual([]);
    });

    it('keeps an optional step whose capability exists', () => {
      const subject = plan([step('a', { optional: true })]);
      expect(repairPlan(subject, catalogOf('tool.a')).plan).toBe(subject);
    });

    it('leaves a required step alone even when its capability is missing', () => {
      // Repair does not touch it; validation then rejects the plan. `optional` is
      // how an author says "nice to have", and inferring that from silence would
      // quietly ship a plan that does less than it claims.
      const subject = plan([step('a')]);
      const result = repairPlan(subject, catalogOf());

      expect(result.plan.steps).toHaveLength(1);
      expect(result.dropped).toEqual([]);
    });
  });

  describe('dropping', () => {
    it('drops an optional step whose capability is missing', () => {
      const result = repairPlan(
        plan([step('a', { optional: true }), step('b')]),
        catalogOf('tool.b'),
      );

      expect(result.plan.steps.map((s) => s.name)).toEqual(['b']);
      expect(result.dropped).toEqual([
        { name: 'a', reason: 'optional step dropped: tool "tool.a" is not registered' },
      ]);
    });

    it('records the repair in metadata', () => {
      // The plan is no longer what the strategy proposed. Anything reading it
      // later should see that without diffing against a proposal it does not have.
      const result = repairPlan(
        plan([step('a', { optional: true }), step('b')]),
        catalogOf('tool.b'),
      );

      expect(result.plan.metadata['repaired']).toBe(true);
      expect(result.plan.metadata['droppedSteps']).toEqual(['a']);
    });

    it('drops an optional step whose capability exists under the other kind', () => {
      const catalog = new StaticCapabilityCatalog([
        capability('thing', { kind: 'agent' }),
      ]);
      const result = repairPlan(
        plan([
          step('a', { optional: true, capability: { kind: 'tool', name: 'thing' } }),
          step('b'),
        ]),
        catalog,
      );
      expect(result.plan.steps.map((s) => s.name)).toEqual(['b']);
    });
  });

  describe('rewiring — the reason this module exists', () => {
    it('contracts a -> b -> c into a -> c when b is dropped', () => {
      // The canonical case. Deleting b and leaving c depending on it would produce
      // "depends on unknown step" — trading a missing capability for a broken
      // graph, which is worse than doing nothing.
      const result = repairPlan(
        plan([
          step('a'),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c', { dependsOn: ['b'] }),
        ]),
        catalogOf('tool.a', 'tool.c'),
      );

      expect(result.plan.steps.map((s) => s.name)).toEqual(['a', 'c']);
      expect(result.plan.steps.find((s) => s.name === 'c')?.dependsOn).toEqual(['a']);
    });

    it('preserves order: c still runs after a', () => {
      const result = repairPlan(
        plan([
          step('a'),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c', { dependsOn: ['b'] }),
        ]),
        catalogOf('tool.a', 'tool.c'),
      );

      expect(runsAfter(result.plan.steps, 'c', 'a')).toBe(true);
    });

    it('contracts a chain of dropped steps', () => {
      // a -> b -> c -> d with b and c both dropped. Resolving one level would
      // leave d depending on b, which no longer exists.
      const result = repairPlan(
        plan([
          step('a'),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c', { optional: true, dependsOn: ['b'] }),
          step('d', { dependsOn: ['c'] }),
        ]),
        catalogOf('tool.a', 'tool.d'),
      );

      expect(result.plan.steps.map((s) => s.name)).toEqual(['a', 'd']);
      expect(result.plan.steps.find((s) => s.name === 'd')?.dependsOn).toEqual(['a']);
    });

    it('makes a step a root when every dependency was dropped', () => {
      const result = repairPlan(
        plan([step('a', { optional: true }), step('b', { dependsOn: ['a'] })]),
        catalogOf('tool.b'),
      );

      expect(result.plan.steps.find((s) => s.name === 'b')?.dependsOn).toEqual([]);
    });

    it('deduplicates when two dropped steps share a dependency', () => {
      // a fans out to b and c, both dropped, and d joins them. Naive rewiring
      // gives d `['a','a']` — legal but a lie about the graph's shape.
      const result = repairPlan(
        plan([
          step('a'),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c', { optional: true, dependsOn: ['a'] }),
          step('d', { dependsOn: ['b', 'c'] }),
        ]),
        catalogOf('tool.a', 'tool.d'),
      );

      expect(result.plan.steps.find((s) => s.name === 'd')?.dependsOn).toEqual(['a']);
    });

    it('keeps surviving dependencies alongside rewired ones', () => {
      const result = repairPlan(
        plan([
          step('a'),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c'),
          step('d', { dependsOn: ['b', 'c'] }),
        ]),
        catalogOf('tool.a', 'tool.c', 'tool.d'),
      );

      const d = result.plan.steps.find((s) => s.name === 'd');
      expect(new Set(d?.dependsOn)).toEqual(new Set(['a', 'c']));
    });

    it('leaves untouched steps by identity', () => {
      const steps = [step('a'), step('b', { optional: true }), step('c')];
      const result = repairPlan(plan(steps), catalogOf('tool.a', 'tool.c'));

      // `a` and `c` never depended on `b`, so they should not be rebuilt.
      expect(result.plan.steps[0]).toBe(steps[0]);
      expect(result.plan.steps[1]).toBe(steps[2]);
    });

    it('terminates on a cycle among dropped steps', () => {
      // Repair runs *before* validation's verdict is acted on, so it must
      // terminate on input that is about to be declared invalid — rather than hang
      // while producing the error message.
      const result = repairPlan(
        plan([
          step('a', { optional: true, dependsOn: ['b'] }),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c', { dependsOn: ['a'] }),
        ]),
        catalogOf('tool.c'),
      );

      expect(result.plan.steps.map((s) => s.name)).toEqual(['c']);
      expect(result.plan.steps[0]?.dependsOn).toEqual([]);
    });
  });

  describe('repair then validate — the pipeline contract', () => {
    it('produces a plan that validates, given a valid input plan', () => {
      const catalog = catalogOf('tool.a', 'tool.c');
      const result = repairPlan(
        plan([
          step('a'),
          step('b', { optional: true, dependsOn: ['a'] }),
          step('c', { dependsOn: ['b'] }),
        ]),
        catalog,
      );

      expect(new PlanValidator(catalog).validate(result.plan).ok).toBe(true);
    });
  });

  describe('properties', () => {
    /**
     * Generate a random DAG.
     *
     * Acyclic by construction: a step may only depend on earlier ones. Seeded by
     * index rather than Math.random, so a failure is reproducible — a flaky
     * property test is worse than no property test, because it teaches you to
     * ignore it.
     */
    function randomPlan(seed: number, size: number): Plan {
      // Mulberry32: tiny, deterministic, well-distributed enough for this.
      let state = seed >>> 0;
      const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      const steps: PlanStep[] = [];
      for (let i = 0; i < size; i++) {
        const deps = steps.filter(() => next() < 0.4).map((s) => s.name);
        steps.push(
          step(`s${String(i)}`, {
            optional: next() < 0.5,
            dependsOn: deps,
            capability: { kind: 'tool', name: `tool.s${String(i)}` },
          }),
        );
      }
      return plan(steps);
    }

    it('never leaves a dangling dependency, over 200 random graphs', () => {
      for (let seed = 0; seed < 200; seed++) {
        const subject = randomPlan(seed, 8);
        // Half the tools exist, chosen by parity so the catalog is deterministic.
        const catalog = catalogOf(
          ...subject.steps
            .filter((_, index) => index % 2 === 0)
            .map((s) => s.capability.name),
        );

        const result = repairPlan(subject, catalog);
        const names = new Set(result.plan.steps.map((s) => s.name));

        for (const dep of dependencyNames(result.plan.steps)) {
          expect(
            names.has(dep),
            `seed ${String(seed)}: dangling dependency "${dep}"`,
          ).toBe(true);
        }
      }
    });

    it('never drops a required step, over 200 random graphs', () => {
      for (let seed = 0; seed < 200; seed++) {
        const subject = randomPlan(seed, 8);
        const catalog = catalogOf();
        const result = repairPlan(subject, catalog);

        const required = subject.steps
          .filter((s) => s.optional !== true)
          .map((s) => s.name);
        const survivors = new Set(result.plan.steps.map((s) => s.name));

        for (const name of required) {
          expect(
            survivors.has(name),
            `seed ${String(seed)}: dropped required "${name}"`,
          ).toBe(true);
        }
      }
    });

    it('preserves transitive order between surviving steps, over 200 random graphs', () => {
      // The invariant that makes contraction correct rather than merely tidy: if
      // `y` ran after `x` before repair, it must still run after `x` after it.
      for (let seed = 0; seed < 200; seed++) {
        const subject = randomPlan(seed, 7);
        const catalog = catalogOf(
          ...subject.steps
            .filter((_, index) => index % 3 !== 0)
            .map((s) => s.capability.name),
        );

        const result = repairPlan(subject, catalog);
        const survivors = result.plan.steps.map((s) => s.name);

        for (const x of survivors) {
          for (const y of survivors) {
            if (x === y) continue;
            if (!runsAfter(subject.steps, y, x)) continue;
            expect(
              runsAfter(result.plan.steps, y, x),
              `seed ${String(seed)}: "${y}" no longer runs after "${x}"`,
            ).toBe(true);
          }
        }
      }
    });

    it('always produces an acyclic graph, over 200 random graphs', () => {
      for (let seed = 0; seed < 200; seed++) {
        const subject = randomPlan(seed, 8);
        const catalog = catalogOf(
          ...subject.steps.filter((_, i) => i % 2 === 1).map((s) => s.capability.name),
        );
        const result = repairPlan(subject, catalog);

        // Every surviving step's dependencies must appear before it in some
        // topological order; PlanValidator uses the kernel's topoSort to say so.
        const verdict = new PlanValidator(catalog).validate(result.plan);
        const cycles = verdict.ok
          ? []
          : verdict.issues.filter((issue) => issue.message.includes('cycle'));
        expect(cycles, `seed ${String(seed)}: repair introduced a cycle`).toEqual([]);
      }
    });
  });
});
