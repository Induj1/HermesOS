/**
 * Template planning: known goals, known plans.
 *
 * A registry of named templates. Each declares how to recognise a goal and how to
 * decompose it. The first one that matches, by priority, wins; if none matches
 * the strategy declines and the chain moves on.
 *
 * ## Why this is not a placeholder
 *
 * It is tempting to read "deterministic planner" as scaffolding until a model
 * arrives. It is the opposite. Most of what a personal assistant does is not
 * novel — a morning brief is a morning brief every morning — and for a known
 * workflow a template is *better* than a model on every axis that matters: it is
 * free, instant, offline, and identical every time. A model that re-derives the
 * same five steps daily, occasionally getting them wrong, is worse in every
 * respect except novelty.
 *
 * So the intended end state is not "templates get replaced". It is templates
 * first, model second: the chain tries what it knows, and only pays a model for
 * goals nobody has taught it (RFC-0003 §5.2). That ordering also happens to make
 * the system work when the model is down, which is the failure philosophy the
 * repository asks for — but the ordering earns its place on cost and correctness
 * alone.
 *
 * ## Matching is deliberately dumb
 *
 * `keywords` and `pattern` are string matching, not understanding. That is
 * honest: this strategy recognises *phrasings it was taught*, and declines
 * everything else rather than guessing. Understanding is a model's job, and a
 * model-backed strategy sits in front of this one in the chain. A template
 * strategy that tried to be clever would fail at both.
 */

import { InvalidInputError } from '../errors.js';
import {
  buildPlan,
  type PlanContext,
  type PlanStrategy,
} from '../ports/plan-strategy.js';
import type { Goal, Plan, PlanStep } from '../model.js';

/** How a template recognises a goal it can handle. */
export interface TemplateMatcher {
  /**
   * Every keyword must appear in the goal statement, case-insensitively, on a
   * word boundary.
   *
   * AND rather than OR, because OR matches far too eagerly: a "brief" template
   * triggering on "brief" alone would claim "brief me on why the deploy broke",
   * which it cannot do. A template that over-matches is worse than one that never
   * matches, because declining is free and being wrong is not.
   */
  readonly keywords?: readonly string[];
  /** Full control. Applied to the raw statement. */
  readonly pattern?: RegExp;
  /** Escape hatch for structure a string cannot express: goal.context, subject, time. */
  readonly predicate?: (goal: Goal) => boolean;
}

export interface PlanTemplate {
  /** Stable name. Recorded in plan metadata so you can tell which template fired. */
  readonly name: string;
  readonly description: string;
  readonly match: TemplateMatcher;
  /**
   * Tried highest first. Ties break on registration order, so a template list is
   * deterministic without every template having to declare a priority.
   */
  readonly priority?: number;
  /** Why this decomposition. Becomes `Plan.rationale`. */
  readonly rationale?: string;
  /**
   * The decomposition.
   *
   * A function of the goal rather than a static list, so a template can vary its
   * steps with `goal.context` — which is the difference between a template
   * language and a template *system*. It must be pure and synchronous: templates
   * are the deterministic half of the chain, and one that awaited a network call
   * would forfeit exactly the property that makes it the fallback.
   */
  build(goal: Goal): readonly PlanStep[];
}

export interface TemplateStrategyOptions {
  readonly name?: string;
}

export class TemplateStrategy implements PlanStrategy {
  readonly name: string;
  readonly #templates: readonly PlanTemplate[];

  constructor(
    templates: readonly PlanTemplate[],
    options: TemplateStrategyOptions = {},
  ) {
    this.name = options.name ?? 'template';

    const duplicate = findDuplicate(templates.map((template) => template.name));
    if (duplicate !== undefined) {
      // The kernel's no-clobber rule, applied one layer up: "two plugins that both
      // define a 'search' tool is a conflict the host must resolve explicitly, not
      // a race decided by plugin load order" (kernel registry.ts). Two templates
      // with one name is the same conflict, and silently keeping the last would
      // make which plan you get depend on array order.
      throw new InvalidInputError([`duplicate template name "${duplicate}"`]);
    }

    // Sorted once, at construction. Stable sort keeps registration order as the
    // tiebreak, so a caller who never sets a priority still gets a defined
    // outcome rather than an engine-dependent one.
    this.#templates = [...templates].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
  }

  /** The templates this strategy will try, best first. For diagnostics and docs. */
  get templates(): readonly PlanTemplate[] {
    return this.#templates;
  }

  // Satisfies the async PlanStrategy contract. Template matching is pure CPU; a
  // model-backed strategy really does await, and narrowing the port to suit this
  // one would break it.
  // eslint-disable-next-line @typescript-eslint/require-await -- see above
  async propose(goal: Goal, ctx: PlanContext): Promise<Plan | undefined> {
    const template = this.#templates.find((candidate) =>
      matches(candidate.match, goal),
    );

    if (!template) {
      // Declining is a normal outcome, not a failure: it is what hands the goal
      // to the next strategy in the chain.
      ctx.logger.debug('No template matched; declining', {
        goal: goal.statement,
        templates: this.#templates.length,
      });
      return undefined;
    }

    const steps = template.build(goal);
    ctx.logger.debug('Template matched', {
      template: template.name,
      steps: steps.length,
    });

    return buildPlan(this.name, goal, steps, ctx, {
      rationale:
        template.rationale ??
        `Matched the "${template.name}" template: ${template.description}`,
      // 1, and meant: a template either matched its declared phrasing or it did
      // not. There is no guess here to be uncertain about. A model-backed strategy
      // reports something lower, and that difference is the point of the field.
      confidence: 1,
      metadata: { template: template.name },
    });
  }
}

/**
 * Does this matcher accept this goal?
 *
 * Every declared clause must pass (AND). A matcher declaring nothing matches
 * nothing — **not** everything. That default is deliberate: an empty matcher is
 * almost certainly an authoring mistake, and reading it as "match all" would put
 * a catch-all at the head of the chain and swallow every goal in the system. The
 * failure mode of the strict reading is a template that never fires, which is
 * visible and harmless; the failure mode of the loose one is silent and total.
 */
export function matches(matcher: TemplateMatcher, goal: Goal): boolean {
  const clauses: boolean[] = [];

  if (matcher.keywords !== undefined) {
    clauses.push(
      matcher.keywords.length > 0 &&
        matcher.keywords.every((keyword) => containsWord(goal.statement, keyword)),
    );
  }
  if (matcher.pattern !== undefined) {
    // `lastIndex` on a /g/ or /y/ regex persists between calls, so the same
    // matcher would alternate between hit and miss across goals. Testing from a
    // fresh regex keeps matching a function of its inputs.
    clauses.push(
      new RegExp(
        matcher.pattern.source,
        matcher.pattern.flags.replace(/[gy]/g, ''),
      ).test(goal.statement),
    );
  }
  if (matcher.predicate !== undefined) {
    clauses.push(matcher.predicate(goal));
  }

  return clauses.length > 0 && clauses.every(Boolean);
}

/**
 * Whole-word, case-insensitive containment.
 *
 * Word boundaries rather than `includes`, so a "pr" keyword does not match
 * "prepare". Escaped, because a keyword is data — a template author writing "c++"
 * should get a match, not a regex syntax error.
 */
function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is defined in terms of \w, which is ASCII-only, so it does not work at the
  // edges of a keyword like "café" or "日本". Falling back to plain containment
  // there is the pragmatic call: a slightly loose match on a non-ASCII keyword
  // beats never matching one at all.
  const asciiOnly = /^[\w\s-]+$/.test(word);
  const source = asciiOnly ? `\\b${escaped}\\b` : escaped;
  return new RegExp(source, 'i').test(haystack);
}

function findDuplicate(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}
