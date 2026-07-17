/**
 * The deterministic reasoner and the chain.
 *
 * The chain's tests are the important ones: it is where "if AI fails, fall back
 * to deterministic behaviour" actually lives, and that claim is only true if a
 * reasoner that throws really does hand over rather than taking the agent down
 * with it.
 */

import { describe, expect, it, vi } from 'vitest';
import { matches, RuleBasedReasoner } from '../src/reasoners/rule-based.js';
import type { Rule } from '../src/reasoners/rule-based.js';
import { ReasonerChain } from '../src/reasoners/reasoner-chain.js';
import { InvalidInputError, ReasoningFailedError } from '../src/errors.js';
import type { AgentDecision } from '../src/model.js';
import type { Reasoner } from '../src/ports/reasoner.js';
import { context, recordingLogger, request } from './helpers/fixtures.js';

const answer = (content: string): AgentDecision => ({ kind: 'answer', content });

const rule = (name: string, overrides: Partial<Rule> = {}): Rule => ({
  name,
  description: `The ${name} rule`,
  match: { contains: [name] },
  decide: () => answer(`${name} handled it`),
  ...overrides,
});

/** A reasoner that always returns the given decision. */
const always = (name: string, decision: AgentDecision): Reasoner => ({
  name,
  reason: () => Promise.resolve(decision),
});

const abstaining = (name: string): Reasoner =>
  always(name, { kind: 'abstain', reason: 'not mine' });

const throwing = (name: string, message = 'model is down'): Reasoner => ({
  name,
  reason: () => Promise.reject(new Error(message)),
});

describe('RuleBasedReasoner', () => {
  it('decides with the first rule that matches', async () => {
    const reasoner = new RuleBasedReasoner([rule('weather'), rule('calendar')]);

    const decision = await reasoner.reason(request('what is the weather'), context());

    expect(decision).toMatchObject({ kind: 'answer', content: 'weather handled it' });
  });

  // Abstaining is the normal outcome, not a failure: it is what hands the request
  // to the next reasoner in the chain.
  it('abstains when nothing matches, rather than failing', async () => {
    const reasoner = new RuleBasedReasoner([rule('weather')]);

    const decision = await reasoner.reason(request('something else'), context());

    expect(decision).toMatchObject({ kind: 'abstain' });
  });

  it('tries rules in priority order, not declaration order', async () => {
    const reasoner = new RuleBasedReasoner([
      rule('shared', { match: { contains: ['x'] }, decide: () => answer('low') }),
      rule('shared-high', {
        match: { contains: ['x'] },
        priority: 10,
        decide: () => answer('high'),
      }),
    ]);

    expect(await reasoner.reason(request('x'), context())).toMatchObject({
      content: 'high',
    });
  });

  // The kernel's registry rule one layer up: silently keeping the last would make
  // which rule fires depend on array order.
  it('refuses two rules with one name', () => {
    expect(() => new RuleBasedReasoner([rule('same'), rule('same')])).toThrow(
      InvalidInputError,
    );
  });

  it('explains itself in the rationale', async () => {
    const reasoner = new RuleBasedReasoner([rule('weather')]);

    const decision = await reasoner.reason(request('weather'), context());

    expect(decision).toMatchObject({
      rationale: 'Matched the "weather" rule: The weather rule',
    });
  });

  it('leaves a rule own rationale alone', async () => {
    const reasoner = new RuleBasedReasoner([
      rule('weather', {
        decide: () => ({ kind: 'answer', content: 'x', rationale: 'mine' }),
      }),
    ]);

    expect(await reasoner.reason(request('weather'), context())).toMatchObject({
      rationale: 'mine',
    });
  });

  // A rule engine that could only answer would force every deterministic path
  // that needs a tool to be written as a model-backed agent — exactly backwards.
  it('lets a rule ask for tools rather than only answer', async () => {
    const reasoner = new RuleBasedReasoner([
      rule('weather', {
        decide: () => ({
          kind: 'tools',
          requests: [{ id: 'r1', name: 'forecast', kind: 'tool', args: {} }],
        }),
      }),
    ]);

    expect(await reasoner.reason(request('weather'), context())).toMatchObject({
      kind: 'tools',
    });
  });

  it('awaits a rule that needs to read memory', async () => {
    const reasoner = new RuleBasedReasoner([
      rule('weather', { decide: () => Promise.resolve(answer('async')) }),
    ]);

    expect(await reasoner.reason(request('weather'), context())).toMatchObject({
      content: 'async',
    });
  });

  it('names itself, and takes a name', () => {
    expect(new RuleBasedReasoner([]).name).toBe('rules');
    expect(new RuleBasedReasoner([], { name: 'triage' }).name).toBe('triage');
  });

  it('exposes its rules, best first', () => {
    const reasoner = new RuleBasedReasoner([rule('a'), rule('b', { priority: 5 })]);

    expect(reasoner.rules.map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('matches', () => {
  const ctx = context();

  // An empty matcher is almost certainly an authoring mistake, and reading it as
  // "match all" would put a catch-all at the head of the chain and swallow every
  // request in the system.
  it('matches nothing when it declares nothing', () => {
    expect(matches({}, request('anything'), ctx)).toBe(false);
  });

  it('requires every `contains` term', () => {
    expect(matches({ contains: ['a', 'b'] }, request('a and b'), ctx)).toBe(true);
    expect(matches({ contains: ['a', 'b'] }, request('only a'), ctx)).toBe(false);
  });

  it('is case-insensitive on contains', () => {
    expect(matches({ contains: ['Weather'] }, request('the WEATHER today'), ctx)).toBe(
      true,
    );
  });

  it('requires one of `containsAny`', () => {
    expect(matches({ containsAny: ['x', 'y'] }, request('has y'), ctx)).toBe(true);
    expect(matches({ containsAny: ['x', 'y'] }, request('has z'), ctx)).toBe(false);
  });

  it('matches a pattern against the raw input, not the lowercased one', () => {
    expect(matches({ pattern: /^Weather/ }, request('Weather today'), ctx)).toBe(true);
    expect(matches({ pattern: /^Weather/ }, request('the weather'), ctx)).toBe(false);
  });

  it('requires context keys', () => {
    expect(
      matches(
        { requiresContext: ['user'] },
        request('x', { context: { user: 'ada' } }),
        ctx,
      ),
    ).toBe(true);
    expect(matches({ requiresContext: ['user'] }, request('x'), ctx)).toBe(false);
  });

  it('gives a `when` clause the last word', () => {
    expect(matches({ contains: ['a'], when: () => false }, request('a'), ctx)).toBe(
      false,
    );
    expect(matches({ when: () => true }, request('anything'), ctx)).toBe(true);
  });

  // So a `when` clause is only paid for once the cheap checks pass.
  it('does not run `when` if a cheaper clause already failed', () => {
    const when = vi.fn().mockReturnValue(true);

    matches({ contains: ['nope'], when }, request('something'), ctx);

    expect(when).not.toHaveBeenCalled();
  });

  // `String({a: 1})` is '[object Object]', which would make every object match
  // any matcher containing "object".
  it('matches inside a structured input by rendering it as JSON', () => {
    expect(matches({ contains: ['weather'] }, request({ topic: 'weather' }), ctx)).toBe(
      true,
    );
    expect(matches({ contains: ['object'] }, request({ topic: 'weather' }), ctx)).toBe(
      false,
    );
  });

  it('ANDs every declared clause', () => {
    const matcher = { contains: ['a'], containsAny: ['b', 'c'], pattern: /a/ };

    expect(matches(matcher, request('a and b'), ctx)).toBe(true);
    expect(matches(matcher, request('a alone'), ctx)).toBe(false);
  });
});

// Where "if AI fails, fall back to deterministic behaviour" actually lives.
describe('ReasonerChain', () => {
  it('takes the first reasoner that decides', async () => {
    const chain = new ReasonerChain([
      always('first', answer('one')),
      always('second', answer('two')),
    ]);

    expect(await chain.reason(request(), context())).toMatchObject({ content: 'one' });
  });

  it('skips a reasoner that abstains', async () => {
    const chain = new ReasonerChain([
      abstaining('llm'),
      always('rules', answer('fallback')),
    ]);

    expect(await chain.reason(request(), context())).toMatchObject({
      content: 'fallback',
    });
  });

  // The whole degradation story: no circuit breaker, no health check — the
  // broken reasoner throws and the next one answers.
  it('falls through when a reasoner throws', async () => {
    const chain = new ReasonerChain([
      throwing('llm'),
      always('rules', answer('fallback')),
    ]);

    expect(await chain.reason(request(), context())).toMatchObject({
      content: 'fallback',
    });
  });

  it('reports the reasoner that broke', async () => {
    const { logger, messages } = recordingLogger();
    const chain = new ReasonerChain([throwing('llm'), always('rules', answer('ok'))]);

    await chain.reason(request(), context({ logger }));

    expect(messages).toContainEqual({
      level: 'warn',
      message: 'Reasoner threw; falling through to the next',
    });
  });

  it('survives a reasoner that throws a non-Error', async () => {
    const rude: Reasoner = {
      name: 'rude',
      // Rejecting with a non-Error is the scenario under test: a third-party
      // reasoner is not obliged to be well-behaved, and the chain must survive
      // one that is not.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
      reason: () => Promise.reject('a string'),
    };
    const chain = new ReasonerChain([rude, always('rules', answer('fallback'))]);

    expect(await chain.reason(request(), context())).toMatchObject({
      content: 'fallback',
    });
  });

  it('stops at the first decision and does not consult later reasoners', async () => {
    const later = { name: 'later', reason: vi.fn() };
    const chain = new ReasonerChain([always('first', answer('one')), later]);

    await chain.reason(request(), context());

    expect(later.reason).not.toHaveBeenCalled();
  });

  // Abstaining rather than throwing is what makes a chain nestable inside another.
  it('abstains when everyone declined, so an outer chain can move on', async () => {
    const chain = new ReasonerChain([abstaining('a'), abstaining('b')]);

    const decision = await chain.reason(request(), context());

    expect(decision.kind).toBe('abstain');
    // Narrowed rather than matched loosely: the reason is the chain's account of
    // itself, and it is the only thing an operator has to read.
    if (decision.kind !== 'abstain') throw new Error('expected an abstain');
    expect(decision.reason).toContain('a (abstained)');
  });

  it('nests inside another chain', async () => {
    const inner = new ReasonerChain([abstaining('a')], { name: 'inner' });
    const outer = new ReasonerChain([inner, always('rules', answer('outer answered'))]);

    expect(await outer.reason(request(), context())).toMatchObject({
      content: 'outer answered',
    });
  });

  it('abstains for an empty chain rather than pretending to decide', async () => {
    const decision = await new ReasonerChain([]).reason(request(), context());

    expect(decision.kind).toBe('abstain');
    if (decision.kind !== 'abstain') throw new Error('expected an abstain');
    expect(decision.reason).toContain('no reasoners');
  });

  it('throws when asked to, for an agent that must produce something', async () => {
    const chain = new ReasonerChain([throwing('llm'), abstaining('rules')], {
      failWhenExhausted: true,
    });

    const promise = chain.reason(request(), context());

    await expect(promise).rejects.toThrow(ReasoningFailedError);
    // "Reasoning failed" alone makes a three-reasoner chain undebuggable.
    await expect(promise).rejects.toMatchObject({
      attempts: [
        { reasoner: 'llm', outcome: 'threw', reason: 'model is down' },
        { reasoner: 'rules', outcome: 'abstained', reason: 'not mine' },
      ],
    });
  });

  it('names an empty chain as a wiring mistake when it must decide', async () => {
    const chain = new ReasonerChain([], { failWhenExhausted: true });

    await expect(chain.reason(request(), context())).rejects.toThrow(
      /empty reasoner chain/,
    );
  });

  describe('cancellation', () => {
    it('stops before running anything when already aborted', async () => {
      const first = { name: 'first', reason: vi.fn() };
      const chain = new ReasonerChain([first]);

      await expect(
        chain.reason(request(), context({ signal: AbortSignal.abort() })),
      ).rejects.toThrow();
      expect(first.reason).not.toHaveBeenCalled();
    });

    it('does not run the rest of the chain after the caller leaves', async () => {
      const controller = new AbortController();
      const second = { name: 'second', reason: vi.fn() };
      const aborting: Reasoner = {
        name: 'aborting',
        reason: () => {
          controller.abort();
          return Promise.resolve({ kind: 'abstain' } as AgentDecision);
        },
      };
      const chain = new ReasonerChain([aborting, second]);

      await expect(
        chain.reason(request(), context({ signal: controller.signal })),
      ).rejects.toThrow();
      expect(second.reason).not.toHaveBeenCalled();
    });

    // An abort is the caller leaving, not the reasoner failing. Falling through
    // would ignore the abort; blaming the reasoner would blame the wrong thing.
    it('propagates an abort rather than blaming the reasoner that noticed it', async () => {
      const controller = new AbortController();
      const fallback = { name: 'fallback', reason: vi.fn() };
      const aborting: Reasoner = {
        name: 'aborting',
        reason: () => {
          controller.abort();
          return Promise.reject(new Error('aborted'));
        },
      };
      const chain = new ReasonerChain([aborting, fallback]);

      await expect(
        chain.reason(request(), context({ signal: controller.signal })),
      ).rejects.toThrow('aborted');
      expect(fallback.reason).not.toHaveBeenCalled();
    });
  });

  it('exposes its reasoners, in order', () => {
    const first = abstaining('a');
    const chain = new ReasonerChain([first]);

    expect(chain.reasoners).toEqual([first]);
    expect(chain.name).toBe('chain');
  });
});
