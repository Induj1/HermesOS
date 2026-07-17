/**
 * Template matching and proposal.
 */

import { describe, expect, it } from 'vitest';
import { TemplateStrategy, matches } from '../src/strategies/template-strategy.js';
import { InvalidInputError } from '../src/errors.js';
import type { PlanTemplate } from '../src/strategies/template-strategy.js';
import { context, goal, step } from './helpers/fixtures.js';

function template(name: string, overrides: Partial<PlanTemplate> = {}): PlanTemplate {
  return {
    name,
    description: `The ${name} template`,
    match: { keywords: [name] },
    build: () => [step('a')],
    ...overrides,
  };
}

describe('matches', () => {
  describe('keywords', () => {
    it('matches when every keyword is present', () => {
      expect(
        matches({ keywords: ['brief', 'morning'] }, goal('my morning brief please')),
      ).toBe(true);
    });

    it('requires all keywords, not any', () => {
      // OR would match far too eagerly: a "brief" template triggering on "brief"
      // alone would claim "brief me on why the deploy broke", which it cannot do.
      expect(
        matches({ keywords: ['brief', 'morning'] }, goal('brief me on the outage')),
      ).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(matches({ keywords: ['brief'] }, goal('BRIEF me'))).toBe(true);
    });

    it('matches on word boundaries, not substrings', () => {
      // A "pr" keyword must not match "prepare".
      expect(matches({ keywords: ['pr'] }, goal('prepare the thing'))).toBe(false);
      expect(matches({ keywords: ['pr'] }, goal('review the pr'))).toBe(true);
    });

    it('treats a keyword as data, not as a pattern', () => {
      // A template author writing "c++" should get a match, not a regex error.
      expect(() =>
        matches({ keywords: ['c++'] }, goal('write c++ code')),
      ).not.toThrow();
      expect(matches({ keywords: ['c++'] }, goal('write c++ code'))).toBe(true);
    });

    it('matches a non-ASCII keyword', () => {
      // \b is defined via \w, which is ASCII-only, so word-boundary matching does
      // not work at the edges of "café". A slightly loose match beats never
      // matching at all.
      expect(matches({ keywords: ['café'] }, goal('book the café'))).toBe(true);
    });

    it('does not match an empty keyword list', () => {
      expect(matches({ keywords: [] }, goal('anything'))).toBe(false);
    });
  });

  describe('pattern', () => {
    it('matches a regex', () => {
      expect(
        matches({ pattern: /deploy (staging|prod)/ }, goal('deploy prod now')),
      ).toBe(true);
    });

    it('is not affected by a sticky or global flag', () => {
      // lastIndex on a /g/ regex persists between calls, so the same matcher would
      // alternate between hit and miss across goals. Matching must be a function
      // of its inputs.
      const matcher = { pattern: /deploy/g };
      for (let i = 0; i < 5; i++) {
        expect(matches(matcher, goal('deploy prod'))).toBe(true);
      }
    });
  });

  describe('predicate', () => {
    it('can read structure a string cannot express', () => {
      const matcher = {
        predicate: (g: ReturnType<typeof goal>) => g.subject === 'ada',
      };
      expect(matches(matcher, goal('x', { subject: 'ada' }))).toBe(true);
      expect(matches(matcher, goal('x', { subject: 'grace' }))).toBe(false);
    });
  });

  describe('combining', () => {
    it('requires every declared clause to pass', () => {
      const matcher = { keywords: ['deploy'], predicate: () => false };
      expect(matches(matcher, goal('deploy prod'))).toBe(false);
    });

    it('matches nothing when nothing is declared', () => {
      // The most important default in this file. Reading an empty matcher as
      // "match all" would put a catch-all at the head of the chain and swallow
      // every goal in the system — a silent, total failure. A template that never
      // fires is visible and harmless.
      expect(matches({}, goal('literally anything'))).toBe(false);
    });
  });
});

describe('TemplateStrategy', () => {
  it('proposes a plan when a template matches', async () => {
    const strategy = new TemplateStrategy([template('brief')]);
    const plan = await strategy.propose(goal('give me a brief'), context());

    expect(plan).toBeDefined();
    expect(plan?.strategy).toBe('template');
    expect(plan?.metadata['template']).toBe('brief');
    expect(plan?.steps).toHaveLength(1);
  });

  it('declines when nothing matches', async () => {
    // Declining is a normal outcome, not a failure: it is what hands the goal to
    // the next strategy in the chain.
    const strategy = new TemplateStrategy([template('brief')]);
    expect(
      await strategy.propose(goal('something else entirely'), context()),
    ).toBeUndefined();
  });

  it('reports full confidence, and means it', async () => {
    // A template either matched its declared phrasing or it did not; there is no
    // guess to be uncertain about. A model-backed strategy reports something
    // lower, and that difference is the point of the field.
    const strategy = new TemplateStrategy([template('brief')]);
    const plan = await strategy.propose(goal('brief'), context());
    expect(plan?.confidence).toBe(1);
  });

  it('carries the goal onto the plan unchanged', async () => {
    const strategy = new TemplateStrategy([template('brief')]);
    const subject = goal('brief me', { subject: 'ada', context: { tz: 'UTC' } });
    const plan = await strategy.propose(subject, context());
    expect(plan?.goal).toEqual(subject);
  });

  it('uses the template rationale when given one', async () => {
    const strategy = new TemplateStrategy([
      template('brief', { rationale: 'Because mornings' }),
    ]);
    const plan = await strategy.propose(goal('brief'), context());
    expect(plan?.rationale).toBe('Because mornings');
  });

  it('derives a rationale from the description otherwise', async () => {
    const strategy = new TemplateStrategy([template('brief')]);
    const plan = await strategy.propose(goal('brief'), context());
    expect(plan?.rationale).toMatch(/Matched the "brief" template/);
  });

  it('builds steps from the goal, so a template can vary its output', async () => {
    // The difference between a template language and a template system.
    const strategy = new TemplateStrategy([
      template('report', {
        build: (g) => [
          step('a', { intent: `Report for ${String(g.context?.['team'])}` }),
        ],
      }),
    ]);
    const plan = await strategy.propose(
      goal('report', { context: { team: 'infra' } }),
      context(),
    );
    expect(plan?.steps[0]?.intent).toBe('Report for infra');
  });

  describe('ordering', () => {
    it('tries the highest priority first', async () => {
      const strategy = new TemplateStrategy([
        template('low', { match: { keywords: ['x'] }, priority: 1 }),
        template('high', { match: { keywords: ['x'] }, priority: 10 }),
      ]);
      const plan = await strategy.propose(goal('x'), context());
      expect(plan?.metadata['template']).toBe('high');
    });

    it('breaks ties on registration order', async () => {
      // A template list must be deterministic without every template declaring a
      // priority.
      const strategy = new TemplateStrategy([
        template('first', { match: { keywords: ['x'] } }),
        template('second', { match: { keywords: ['x'] } }),
      ]);
      const plan = await strategy.propose(goal('x'), context());
      expect(plan?.metadata['template']).toBe('first');
    });

    it('exposes its templates in the order it will try them', () => {
      const strategy = new TemplateStrategy([
        template('low', { priority: 1 }),
        template('high', { priority: 10 }),
      ]);
      expect(strategy.templates.map((t) => t.name)).toEqual(['high', 'low']);
    });
  });

  describe('construction', () => {
    it('rejects duplicate template names', () => {
      // The kernel's no-clobber rule, one layer up: silently keeping the last
      // would make which plan you get depend on array order.
      expect(
        () => new TemplateStrategy([template('brief'), template('brief')]),
      ).toThrow(InvalidInputError);
    });

    it('accepts an empty template list and declines everything', async () => {
      // Degenerate but legal: a chain may compose an empty template strategy
      // behind a model-backed one.
      const strategy = new TemplateStrategy([]);
      expect(await strategy.propose(goal('anything'), context())).toBeUndefined();
    });

    it('takes a custom name, so a chain can hold two template strategies', () => {
      expect(new TemplateStrategy([], { name: 'builtin' }).name).toBe('builtin');
    });
  });
});
