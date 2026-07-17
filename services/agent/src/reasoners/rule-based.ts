/**
 * RuleBasedReasoner — decides by matching declared rules.
 *
 * Deterministic, needs no network, and costs nothing. It is not a placeholder for
 * a model and is not waiting to be replaced by one: it is the **floor the whole
 * degradation story stands on**. "If AI fails, fall back to deterministic
 * behaviour" is only true if something deterministic can answer, and this is
 * that something.
 *
 * It also does not *reason*, and saying so plainly matters. It recognises. A rule
 * either matched its declared shape or it did not; there is no judgement in it.
 * The honest split is that this handles what somebody already knew how to handle,
 * and `LlmReasoner` handles what nobody taught it — which is why the intended
 * chain is model first, rules behind, and why the rules still answer when the
 * model is down.
 *
 * Modelled deliberately on `TemplateStrategy` (RFC-0003 §7.4), down to the
 * priority sort and the empty-matcher rule, because they are the same idea at
 * different layers and a reader who learned one should not have to learn the
 * other.
 */

import type { AgentContext } from '../context.js';
import { InvalidInputError } from '../errors.js';
import type { AgentDecision, AgentRequest } from '../model.js';
import type { Reasoner } from '../ports/reasoner.js';

/**
 * When a rule applies.
 *
 * Every declared clause must pass (AND). A matcher declaring nothing matches
 * **nothing** — not everything. That default is inherited from `TemplateMatcher`
 * (RFC-0003 §7.5) and for the same reason: an empty matcher is almost certainly
 * an authoring mistake, and reading it as "match all" would put a catch-all at
 * the head of the chain and swallow every request in the system. A rule that
 * never fires is visible and harmless; one that swallows everything is silent and
 * total.
 */
export interface RuleMatcher {
  /** The input, lowercased, must contain every one of these. */
  readonly contains?: readonly string[];
  /** The input, lowercased, must contain at least one of these. */
  readonly containsAny?: readonly string[];
  /** The input must match this. */
  readonly pattern?: RegExp;
  /** These keys must be present on `request.context`. */
  readonly requiresContext?: readonly string[];
  /** The last word. Runs after every other clause passes. */
  readonly when?: (request: AgentRequest, ctx: AgentContext) => boolean;
}

export interface Rule {
  /** Unique within the reasoner. Appears in the decision's rationale. */
  readonly name: string;
  readonly description: string;
  readonly match: RuleMatcher;
  /**
   * What to do when it matches.
   *
   * Returns a decision, so a rule can answer, ask for tools, ask for a plan, or
   * hand off — the full union, not a reduced one. A rule engine that could only
   * answer would force every deterministic path that needs a tool to be written
   * as a model-backed agent, which is exactly backwards.
   *
   * Async because a rule may want to read memory through `ctx.memory`. It must
   * not do anything else with the context, and there is nothing else there.
   */
  decide(
    request: AgentRequest,
    ctx: AgentContext,
  ): Promise<AgentDecision> | AgentDecision;
  /** Higher is tried first. Default 0. Ties keep declaration order. */
  readonly priority?: number;
}

export interface RuleBasedReasonerOptions {
  readonly name?: string;
}

export class RuleBasedReasoner implements Reasoner {
  readonly name: string;
  readonly #rules: readonly Rule[];

  constructor(rules: readonly Rule[], options: RuleBasedReasonerOptions = {}) {
    this.name = options.name ?? 'rules';

    const duplicate = rules.find(
      (rule, index) => rules.findIndex((other) => other.name === rule.name) !== index,
    )?.name;
    if (duplicate !== undefined) {
      // The kernel's registry rule, one layer up: "two plugins that both define a
      // 'search' tool is a conflict the host must resolve explicitly, not a race
      // decided by plugin load order" (kernel `registry.ts`). Two rules with one
      // name is the same conflict, and silently keeping the last would make which
      // rule fires depend on array order.
      throw new InvalidInputError([`duplicate rule name "${duplicate}"`]);
    }

    // Sorted once, at construction. A stable sort keeps declaration order as the
    // tiebreak, so an author who never sets a priority gets a defined outcome
    // rather than an engine-dependent one.
    this.#rules = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** The rules this reasoner will try, best first. For diagnostics and docs. */
  get rules(): readonly Rule[] {
    return this.#rules;
  }

  async reason(request: AgentRequest, ctx: AgentContext): Promise<AgentDecision> {
    for (const rule of this.#rules) {
      if (!matches(rule.match, request, ctx)) continue;

      ctx.logger.debug('Rule matched', { reasoner: this.name, rule: rule.name });
      const decision = await rule.decide(request, ctx);

      // The rule's own rationale wins. It knows why it fired; this only knows
      // that it did.
      return withRationale(
        decision,
        `Matched the "${rule.name}" rule: ${rule.description}`,
      );
    }

    ctx.logger.debug('No rule matched; abstaining', { reasoner: this.name });
    // Abstaining is the normal outcome, not a failure: it is what hands the
    // request to the next reasoner in the chain.
    return {
      kind: 'abstain',
      reason: `No rule in "${this.name}" matched this request`,
    };
  }
}

/**
 * Does this matcher accept this request?
 *
 * Exported because a host writing a `when` clause often wants to reuse the
 * cheaper checks inside it, and because it is the piece most worth testing
 * directly.
 */
export function matches(
  matcher: RuleMatcher,
  request: AgentRequest,
  ctx: AgentContext,
): boolean {
  const clauses = [
    matcher.contains,
    matcher.containsAny,
    matcher.pattern,
    matcher.requiresContext,
    matcher.when,
  ];
  // Declares nothing, matches nothing. See RuleMatcher.
  if (clauses.every((clause) => clause === undefined)) return false;

  const text = textOf(request.input).toLowerCase();

  if (
    matcher.contains &&
    !matcher.contains.every((term) => text.includes(term.toLowerCase()))
  ) {
    return false;
  }
  if (
    matcher.containsAny &&
    !matcher.containsAny.some((term) => text.includes(term.toLowerCase()))
  ) {
    return false;
  }
  if (matcher.pattern && !matcher.pattern.test(textOf(request.input))) return false;
  if (
    matcher.requiresContext &&
    !matcher.requiresContext.every(
      (key) => request.context !== undefined && key in request.context,
    )
  ) {
    return false;
  }
  // Last, so a `when` clause is only paid for once the cheap checks pass.
  if (matcher.when && !matcher.when(request, ctx)) return false;

  return true;
}

/**
 * The request's input as text, for matching.
 *
 * A rule matcher is a text matcher, and `AgentRequest.input` is `unknown` on
 * purpose (see `model.ts`). Rather than force every rule-based agent to take
 * strings, non-strings are rendered — so a matcher can still fire on an object's
 * contents. `JSON.stringify` rather than `String()`, because `String({a: 1})` is
 * `'[object Object]'` and would make every object match every matcher that
 * happened to contain "object".
 */
function textOf(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    // TypeScript types `JSON.stringify` as returning `string`. It does not: for
    // `undefined`, a function, or a symbol it returns `undefined`, and an
    // `AgentRequest.input` is `unknown` and may be any of them. The annotation
    // restores the type the runtime actually has, so the guard is honest.
    const json = JSON.stringify(input) as string | undefined;
    return json ?? '';
  } catch {
    /* c8 ignore next 3 -- A circular input. Unreachable from a session, whose
       request came over a boundary as data; kept because a host can construct an
       AgentRequest by hand, and a matcher throwing inside a chain would take down
       reasoners that had nothing to do with it. */
    return '';
  }
}

/** Attach a rationale to a decision that did not bring its own. */
function withRationale(decision: AgentDecision, rationale: string): AgentDecision {
  if (decision.kind === 'abstain') return decision;
  return decision.rationale === undefined ? { ...decision, rationale } : decision;
}
