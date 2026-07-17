/**
 * Middleware, and the agent/tool-selection odds and ends.
 *
 * The middleware tests are really about one property: `next` returns a
 * *decision*, which is data describing what should happen and has not happened
 * yet — so a guard can refuse it and nothing has been done in the meantime. That
 * is only possible because agents decide rather than act, and it is the clearest
 * demonstration of why the whole subsystem is shaped this way.
 */

import { describe, expect, it, vi } from 'vitest';
import { withMiddleware } from '../src/middleware.js';
import type { AgentMiddleware } from '../src/middleware.js';
import { capabilityOf, defineAgent } from '../src/agent.js';
import { AllTools, NamedTools, NoTools } from '../src/tool-selection.js';
import type { AgentDecision } from '../src/model.js';
import type { Reasoner } from '../src/ports/reasoner.js';
import { capability, context, request } from './helpers/fixtures.js';

const answering = (content = 'ok'): Reasoner => ({
  name: 'base',
  reason: () => Promise.resolve({ kind: 'answer', content } as AgentDecision),
});

describe('withMiddleware', () => {
  it('returns the reasoner untouched when there is no middleware', () => {
    const reasoner = answering();

    expect(withMiddleware(reasoner, [])).toBe(reasoner);
  });

  it('wraps the reasoner and passes the decision through', async () => {
    const seen: string[] = [];
    const logging: AgentMiddleware = async (req, ctx, next) => {
      seen.push('before');
      const decision = await next(req, ctx);
      seen.push('after');
      return decision;
    };

    const decision = await withMiddleware(answering(), [logging]).reason(
      request(),
      context(),
    );

    expect(seen).toEqual(['before', 'after']);
    expect(decision).toMatchObject({ content: 'ok' });
  });

  // The order everyone means by "middleware", and the opposite of what a naive
  // reduce produces.
  it('runs the first middleware outermost', async () => {
    const order: string[] = [];
    const tag =
      (name: string): AgentMiddleware =>
      async (req, ctx, next) => {
        order.push(`${name}:in`);
        const decision = await next(req, ctx);
        order.push(`${name}:out`);
        return decision;
      };

    await withMiddleware(answering(), [tag('first'), tag('second')]).reason(
      request(),
      context(),
    );

    expect(order).toEqual(['first:in', 'second:in', 'second:out', 'first:out']);
  });

  // The thing middleware is really for. In a framework where the agent had
  // already run the tool, an approval guard could only apologise.
  it('lets a guard refuse a decision before anything has happened', async () => {
    const risky: Reasoner = {
      name: 'risky',
      reason: () =>
        Promise.resolve({
          kind: 'tools',
          requests: [
            { id: 'r1', name: 'payment.send', kind: 'tool', args: { amount: 100 } },
          ],
        } as AgentDecision),
    };
    const requireApproval: AgentMiddleware = async (req, ctx, next) => {
      const decision = await next(req, ctx);
      if (decision.kind !== 'tools') return decision;
      if (!decision.requests.some((r) => r.name.startsWith('payment.')))
        return decision;
      return { kind: 'answer', content: 'That needs a human.' };
    };

    const decision = await withMiddleware(risky, [requireApproval]).reason(
      request(),
      context(),
    );

    // Nothing was sent. The decision was data, and the guard read it.
    expect(decision).toMatchObject({ kind: 'answer', content: 'That needs a human.' });
  });

  it('lets a middleware short-circuit without calling the reasoner', async () => {
    const reason = vi.fn();
    const deny: AgentMiddleware = () =>
      Promise.resolve({ kind: 'abstain', reason: 'denied' } as AgentDecision);

    const decision = await withMiddleware({ name: 'base', reason }, [deny]).reason(
      request(),
      context(),
    );

    expect(reason).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ kind: 'abstain' });
  });

  it('lets a middleware rewrite the request', async () => {
    const seen: unknown[] = [];
    const spy: Reasoner = {
      name: 'spy',
      reason: (req) => {
        seen.push(req.input);
        return Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision);
      },
    };
    const redact: AgentMiddleware = async (req, ctx, next) =>
      await next({ ...req, input: '[redacted]' }, ctx);

    await withMiddleware(spy, [redact]).reason(
      request('my password is hunter2'),
      context(),
    );

    expect(seen).toEqual(['[redacted]']);
  });

  // The enforcement point a ToolSelectionStrategy cannot be: a strategy is the
  // agent's own declaration, and this is the host's.
  it('lets a middleware narrow what the reasoner may see', async () => {
    const seen: { capabilities?: readonly unknown[] } = {};
    const spy: Reasoner = {
      name: 'spy',
      reason: (_req, ctx) => {
        seen.capabilities = ctx.capabilities;
        return Promise.resolve({ kind: 'answer', content: 'ok' } as AgentDecision);
      },
    };
    const noPayments: AgentMiddleware = async (req, ctx, next) =>
      await next(req, {
        ...ctx,
        capabilities: ctx.capabilities.filter((c) => !c.name.startsWith('payment.')),
      });

    await withMiddleware(spy, [noPayments]).reason(
      request(),
      context({ capabilities: [capability('search'), capability('payment.send')] }),
    );

    expect(seen.capabilities).toEqual([expect.objectContaining({ name: 'search' })]);
  });

  // An operator reading "logging abstained" would go looking for a reasoner that
  // does not exist.
  it('keeps the reasoner name, because middleware is not a decision-maker', () => {
    const passthrough: AgentMiddleware = async (req, ctx, next) => await next(req, ctx);

    expect(withMiddleware(answering(), [passthrough]).name).toBe('base');
  });

  it('lets a throw out, for a chain to handle', async () => {
    const boom: AgentMiddleware = () => Promise.reject(new Error('guard broke'));

    await expect(
      withMiddleware(answering(), [boom]).reason(request(), context()),
    ).rejects.toThrow('guard broke');
  });
});

describe('defineAgent and capabilityOf', () => {
  it('returns the agent unchanged', () => {
    const agent = { name: 'a', description: 'x', reasoner: answering() };

    expect(defineAgent(agent)).toBe(agent);
  });

  // Derived rather than stored, so it cannot drift from the agent it describes.
  it('derives what an agent says about itself', () => {
    const agent = defineAgent({
      name: 'summariser',
      description: 'Summarises things',
      tags: ['text'],
      reasoner: answering(),
    });

    expect(capabilityOf(agent)).toEqual({
      name: 'summariser',
      description: 'Summarises things',
      tags: ['text'],
    });
  });

  it('reports an empty tag list rather than undefined', () => {
    const agent = defineAgent({ name: 'a', description: 'x', reasoner: answering() });

    expect(capabilityOf(agent).tags).toEqual([]);
  });
});

describe('tool selection', () => {
  const available = [
    capability('calendar.today', { tags: ['calendar', 'read'] }),
    capability('payment.send', { tags: ['money'] }),
    capability('search'),
  ];

  it('AllTools offers everything', () => {
    expect(new AllTools().select(request(), available)).toEqual(available);
    expect(new AllTools().name).toBe('all');
  });

  // Not a null object — the right policy for an agent that must answer from the
  // prompt and memory alone, and the safe one for untrusted input.
  it('NoTools offers nothing', () => {
    expect(new NoTools().select()).toEqual([]);
    expect(new NoTools().name).toBe('none');
  });

  it('NamedTools offers exactly the named ones', () => {
    const selected = new NamedTools({ names: ['search'] }).select(request(), available);

    expect(selected).toEqual([expect.objectContaining({ name: 'search' })]);
  });

  it('NamedTools offers anything carrying a named tag', () => {
    const selected = new NamedTools({ tags: ['calendar'] }).select(
      request(),
      available,
    );

    expect(selected).toEqual([expect.objectContaining({ name: 'calendar.today' })]);
  });

  it('NamedTools takes names and tags together', () => {
    const selected = new NamedTools({ names: ['search'], tags: ['money'] }).select(
      request(),
      available,
    );

    expect(selected.map((c) => c.name)).toEqual(['payment.send', 'search']);
  });

  // Capabilities arrive from plugins at runtime, so an agent declared at module
  // load legitimately names a tool that is not registered yet. Throwing would
  // make agent construction depend on plugin load order.
  it('NamedTools ignores a name that does not exist rather than throwing', () => {
    expect(() =>
      new NamedTools({ names: ['not.registered'] }).select(request(), available),
    ).not.toThrow();
    expect(
      new NamedTools({ names: ['not.registered'] }).select(request(), available),
    ).toEqual([]);
  });

  // Reading an empty declaration as "everything" would silently widen an agent's
  // reach — the direction that fails open.
  it('NamedTools declaring nothing selects nothing, not everything', () => {
    expect(new NamedTools({}).select(request(), available)).toEqual([]);
  });

  it('NamedTools takes a name', () => {
    expect(new NamedTools({ names: ['a'], name: 'calendar-only' }).name).toBe(
      'calendar-only',
    );
    expect(new NamedTools({ names: ['a'] }).name).toBe('named');
  });
});
