/**
 * ReasonerChain — try reasoners in order until one decides.
 *
 * This is the composite reasoner, and it is where "if AI fails, fall back to
 * deterministic behaviour" actually lives. There is no circuit breaker in this
 * package, no health check, no `try`/`catch` around a model call. Instead:
 *
 * - a reasoner that **abstains** hands the request on, and
 * - a reasoner that **throws** is recorded and the chain continues.
 *
 * A model-backed reasoner that is down simply throws, and the `RuleBasedReasoner`
 * behind it answers. **The mechanism is the architecture** — the same argument
 * the planner makes for its strategy chain (RFC-0003 §5.2), and deliberately the
 * same shape, because a reader who learned one should not have to learn another.
 *
 * ## Order is policy
 *
 * The chain takes the first reasoner that does not abstain. It does not rank, and
 * `confidence` is deliberately not used to choose: it is a reasoner's report
 * about itself, and one that overstates it would win every race it should lose.
 * So order belongs to whoever composes the chain — one array, at the composition
 * root. Model first if novelty matters; rules first if cost and determinism do.
 *
 * ## Why this is not `HybridReasoner`
 *
 * "Hybrid" names a *combination* — rules and a model together — which suggests
 * something merges their outputs. Nothing here merges anything. This tries things
 * in order and takes the first answer, which is a chain of responsibility, so it
 * is called one. A hybrid that genuinely merged two reasoners' decisions would
 * need a rule for what to do when they disagree, and there is no defensible one
 * (RFC-0005 §7.3).
 */

import type { AgentContext } from '../context.js';
import { ReasoningFailedError, toError, type ReasonerAttempt } from '../errors.js';
import type { AgentDecision, AgentRequest } from '../model.js';
import type { Reasoner } from '../ports/reasoner.js';

export interface ReasonerChainOptions {
  readonly name?: string;
  /**
   * Throw when every reasoner abstained or threw, rather than abstaining.
   *
   * Default false — the chain abstains, which is what makes a chain nestable
   * inside another chain. Set it at the outermost chain of an agent that must
   * produce something, where "nobody had anything" is a fault rather than a
   * hand-off.
   */
  readonly failWhenExhausted?: boolean;
}

export class ReasonerChain implements Reasoner {
  readonly name: string;
  readonly #reasoners: readonly Reasoner[];
  readonly #failWhenExhausted: boolean;

  constructor(reasoners: readonly Reasoner[], options: ReasonerChainOptions = {}) {
    this.name = options.name ?? 'chain';
    this.#reasoners = reasoners;
    this.#failWhenExhausted = options.failWhenExhausted ?? false;
  }

  /** The reasoners this chain will try, in order. For diagnostics. */
  get reasoners(): readonly Reasoner[] {
    return this.#reasoners;
  }

  async reason(request: AgentRequest, ctx: AgentContext): Promise<AgentDecision> {
    const attempts: ReasonerAttempt[] = [];

    for (const reasoner of this.#reasoners) {
      // Checked between reasoners as well as inside them: a chain of three must
      // not run the remaining two after the caller has gone.
      ctx.signal?.throwIfAborted();

      let decision: AgentDecision;
      try {
        decision = await reasoner.reason(request, ctx);
      } catch (thrown) {
        const error = toError(thrown);
        // An abort is the caller leaving, not the reasoner failing. Trying the
        // next one would ignore the abort; recording it as a reasoner fault would
        // blame the wrong thing. Propagate.
        if (ctx.signal?.aborted === true) throw error;

        ctx.logger.warn('Reasoner threw; falling through to the next', {
          chain: this.name,
          reasoner: reasoner.name,
          error: error.message,
        });
        attempts.push({
          reasoner: reasoner.name,
          outcome: 'threw',
          reason: error.message,
        });
        continue;
      }

      if (decision.kind === 'abstain') {
        attempts.push({
          reasoner: reasoner.name,
          outcome: 'abstained',
          reason: decision.reason ?? 'no reason given',
        });
        continue;
      }

      ctx.logger.debug('Reasoner decided', {
        chain: this.name,
        reasoner: reasoner.name,
        decision: decision.kind,
        attempted: attempts.length + 1,
      });
      return decision;
    }

    if (this.#failWhenExhausted) {
      throw new ReasoningFailedError(this.name, attempts);
    }

    // Abstaining rather than throwing is what makes a chain nestable: an outer
    // chain must be able to try this one and move on.
    return {
      kind: 'abstain',
      reason:
        attempts.length === 0
          ? `Chain "${this.name}" has no reasoners`
          : `Every reasoner in "${this.name}" declined: ${attempts
              .map((attempt) => `${attempt.reasoner} (${attempt.outcome})`)
              .join(', ')}`,
    };
  }
}
