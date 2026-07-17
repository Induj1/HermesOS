/**
 * Plan validation.
 *
 * Pure and synchronous — no runtime, no catalog beyond a fixed list. That is the
 * payoff for keeping the planner's most consequential rules a pure function.
 *
 * The capability tests are the ones that matter: they are the planner's reason to
 * exist (see `tests/kernel-gap.test.ts` for the gap they close).
 */

import { describe, expect, it } from 'vitest';
import { PlanValidator, graphDepth } from '../src/validation/plan-validator.js';
import { PlanValidationError } from '../src/errors.js';
import { StaticCapabilityCatalog } from '../src/ports/capability-catalog.js';
import { capability, catalogOf, goal, plan, step } from './helpers/fixtures.js';

function issuesOf(result: ReturnType<PlanValidator['validate']>): readonly string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe('PlanValidator', () => {
  describe('capabilities — the check the kernel cannot make', () => {
    it('accepts a plan whose capabilities all exist', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      expect(validator.validate(plan([step('a')])).ok).toBe(true);
    });

    it('rejects a step naming a capability that does not exist', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(plan([step('b')])); // wants tool.b

      expect(result.ok).toBe(false);
      expect(issuesOf(result)[0]).toMatch(
        /wants tool "tool.b", which is not registered/,
      );
    });

    it('explains what the missing capability would have cost', () => {
      // The error is the whole product here: it has to say why this matters, or a
      // reader treats it as pedantry and adds an override.
      const validator = new PlanValidator(catalogOf());
      const result = validator.validate(plan([step('b')]));

      expect(issuesOf(result)[0]).toMatch(
        /would fail mid-mission after earlier steps had already run/,
      );
    });

    it('distinguishes a wrong kind from a missing capability', () => {
      // Different mistake, different fix. "tool.a exists but as an agent" is
      // actionable; "tool.a is missing" would send the reader to install a plugin
      // they already have.
      const validator = new PlanValidator(
        new StaticCapabilityCatalog([capability('thing', { kind: 'agent' })]),
      );
      const result = validator.validate(
        plan([step('a', { capability: { kind: 'tool', name: 'thing' } })]),
      );

      expect(result.ok).toBe(false);
      expect(issuesOf(result)[0]).toMatch(
        /wants tool "thing", but "thing" is registered as a agent/,
      );
      expect(issuesOf(result)[0]).toMatch(
        /Change the step's capability kind to "agent"/,
      );
    });

    it('lets a tool and an agent share a name', () => {
      // The kernel keeps two registries, so this is legal and must not be reported
      // as a conflict.
      const validator = new PlanValidator(
        new StaticCapabilityCatalog([
          capability('search', { kind: 'tool' }),
          capability('search', { kind: 'agent' }),
        ]),
      );

      const result = validator.validate(
        plan([
          step('a', { capability: { kind: 'tool', name: 'search' } }),
          step('b', { capability: { kind: 'agent', name: 'search' } }),
        ]),
      );
      expect(result.ok).toBe(true);
    });

    it('suggests a near-miss for an obvious typo', () => {
      const validator = new PlanValidator(catalogOf('github.create_issue'));
      const result = validator.validate(
        plan([step('a', { capability: { kind: 'tool', name: 'github.crate_issue' } })]),
      );

      expect(issuesOf(result)[0]).toMatch(/Did you mean "github.create_issue"\?/);
    });

    it('does not suggest something unrelated', () => {
      // A wrong suggestion is worse than none: it sends the reader looking in the
      // wrong place.
      const validator = new PlanValidator(catalogOf('github.create_issue'));
      const result = validator.validate(
        plan([step('a', { capability: { kind: 'tool', name: 'send.email' } })]),
      );

      expect(issuesOf(result)[0]).not.toMatch(/Did you mean/);
    });
  });

  describe('shape', () => {
    it('rejects an empty plan', () => {
      const validator = new PlanValidator(catalogOf());
      const result = validator.validate(plan([]));
      expect(issuesOf(result)).toContain('a plan must have at least one step');
    });

    it('rejects an empty intent', () => {
      // Enforced because an unexplainable plan is one nobody will let run
      // unattended.
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(plan([step('a', { intent: '   ' })]));
      expect(issuesOf(result)).toContain('intent must not be empty');
    });

    it('rejects an empty step name', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(plan([step('', { intent: 'x' })]));
      expect(issuesOf(result)).toContain('step name must not be empty');
    });

    it('rejects an empty capability name', () => {
      // Reported as its own issue rather than as "no such capability": an empty
      // name is an authoring bug, and telling the author that "" is not
      // registered would send them looking for a plugin to install.
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(
        plan([step('a', { capability: { kind: 'tool', name: '  ' } })]),
      );

      expect(issuesOf(result)).toContain('capability name must not be empty');
    });

    it('rejects nonsense attempt counts and timeouts', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(
        plan([step('a', { maxAttempts: 0, timeoutMs: -1, priority: NaN })]),
      );

      expect(issuesOf(result)).toContain('maxAttempts must be at least 1');
      expect(issuesOf(result)).toContain('timeoutMs must be positive');
      expect(issuesOf(result)).toContain('priority must be a finite number');
    });
  });

  describe('graph', () => {
    it('rejects a self-dependency', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(plan([step('a', { dependsOn: ['a'] })]));
      expect(issuesOf(result)).toContain('depends on itself');
    });

    it('rejects a dependency on an unknown step', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(plan([step('a', { dependsOn: ['nope'] })]));
      expect(issuesOf(result)).toContain('depends on unknown step "nope"');
    });

    it('rejects a cycle, naming the path', () => {
      // The kernel's topoSort returns the actual cycle rather than "a cycle
      // exists"; reusing it is how the planner gets that for free.
      const validator = new PlanValidator(catalogOf('tool.a', 'tool.b'));
      const result = validator.validate(
        plan([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]),
      );

      expect(issuesOf(result).join()).toMatch(/dependency cycle: [ab] -> [ab] -> [ab]/);
    });

    it('rejects a duplicate step name', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const result = validator.validate(plan([step('a'), step('a')]));
      expect(issuesOf(result)).toContain('duplicate step name "a"');
    });

    it('accepts a diamond', () => {
      const validator = new PlanValidator(
        catalogOf('tool.a', 'tool.b', 'tool.c', 'tool.d'),
      );
      const result = validator.validate(
        plan([
          step('a'),
          step('b', { dependsOn: ['a'] }),
          step('c', { dependsOn: ['a'] }),
          step('d', { dependsOn: ['b', 'c'] }),
        ]),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('constraints', () => {
    it('rejects a plan over maxSteps', () => {
      const validator = new PlanValidator(catalogOf('tool.a', 'tool.b', 'tool.c'));
      const result = validator.validate(
        plan([step('a'), step('b'), step('c')], {
          goal: goal('x', { constraints: { maxSteps: 2 } }),
        }),
      );
      expect(issuesOf(result)[0]).toMatch(/3 steps, exceeding maxSteps of 2/);
    });

    it('rejects a plan deeper than maxDepth', () => {
      const validator = new PlanValidator(catalogOf('tool.a', 'tool.b', 'tool.c'));
      const result = validator.validate(
        plan(
          [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['b'] })],
          {
            goal: goal('x', { constraints: { maxDepth: 2 } }),
          },
        ),
      );
      expect(issuesOf(result)[0]).toMatch(/3 steps deep, exceeding maxDepth of 2/);
    });

    it('does not confuse breadth with depth', () => {
      // The distinction the two constraints exist to draw: a wide fan-out is one
      // round of latency, however many steps it has.
      const validator = new PlanValidator(catalogOf('tool.a', 'tool.b', 'tool.c'));
      const result = validator.validate(
        plan([step('a'), step('b'), step('c')], {
          goal: goal('x', { constraints: { maxDepth: 1 } }),
        }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('reporting', () => {
    it('reports every issue at once, not the first', () => {
      // The kernel's contract, restated: an author fixing a plan wants all the
      // issues. That author is increasingly a model repairing its own output.
      const validator = new PlanValidator(catalogOf());
      const result = validator.validate(
        plan([step('a', { intent: '' }), step('b', { dependsOn: ['ghost'] })]),
      );

      expect(result.ok).toBe(false);
      // missing tool.a, missing tool.b, empty intent, unknown dependency
      expect(issuesOf(result).length).toBeGreaterThanOrEqual(4);
    });

    it('attributes each issue to its step', () => {
      const validator = new PlanValidator(catalogOf());
      const result = validator.validate(plan([step('a')]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.step).toBe('a');
    });

    it('assertValid throws a PlanValidationError carrying the issues', () => {
      const validator = new PlanValidator(catalogOf());
      expect(() => {
        validator.assertValid(plan([step('a')]));
      }).toThrow(PlanValidationError);
    });

    it('assertValid is silent on a good plan', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      expect(() => {
        validator.assertValid(plan([step('a')]));
      }).not.toThrow();
    });

    it('is pure: validating twice gives the same answer', () => {
      const validator = new PlanValidator(catalogOf('tool.a'));
      const subject = plan([step('a')]);
      expect(validator.validate(subject)).toEqual(validator.validate(subject));
    });
  });
});

describe('graphDepth', () => {
  it('is 1 for a single step', () => {
    expect(graphDepth([step('a')])).toBe(1);
  });

  it('is 0 for an empty plan', () => {
    expect(graphDepth([])).toBe(0);
  });

  it('counts the longest chain, not the step count', () => {
    expect(graphDepth([step('a'), step('b'), step('c')])).toBe(1);
    expect(
      graphDepth([
        step('a'),
        step('b', { dependsOn: ['a'] }),
        step('c', { dependsOn: ['b'] }),
      ]),
    ).toBe(3);
  });

  it('takes the longest path through a diamond', () => {
    expect(
      graphDepth([
        step('a'),
        step('b', { dependsOn: ['a'] }),
        step('c', { dependsOn: ['a'] }),
        step('d', { dependsOn: ['b', 'c'] }),
      ]),
    ).toBe(3);
  });

  it('terminates on a cycle instead of hanging', () => {
    // Reached only when validation is about to reject the plan anyway — but a
    // helper that hangs on bad input will eventually hang on bad input.
    expect(() =>
      graphDepth([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]),
    ).not.toThrow();
  });

  it('terminates on a dangling dependency', () => {
    expect(graphDepth([step('a', { dependsOn: ['ghost'] })])).toBe(1);
  });
});
