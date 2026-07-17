/**
 * The agent framework's domain types — plain, serialisable data.
 *
 * ## The type that defines the subsystem
 *
 * {@link AgentDecision} is the whole architecture in one union. An agent's only
 * output is a *description of what should happen*: an answer, a request to run
 * tools, a request to plan, a hand-off, or a refusal. It cannot return "and I
 * already did it", because there is no variant that says so.
 *
 * That is what makes **"agents never execute tools directly"** structural rather
 * than a rule someone has to remember. A reviewer does not have to check whether
 * a new reasoner calls a tool; the return type does not let it say that it did.
 * The same trick the kernel plays with `MissionSpec` — a mission is data, so it
 * can be inspected before it runs — one layer up.
 *
 * ## Why these are not the kernel's types
 *
 * The kernel has an `Agent` too (`agent.ts`), and it is a different thing wearing
 * the same word. A kernel agent is **handed the tool registry and chooses what to
 * call** — it acts. An agent here decides and stops. The two meet in
 * `adapters/kernel-agent.ts`, which is the one place the vocabularies touch, and
 * everywhere else they stay apart. See RFC-0005 §3.1.
 */

import type { Brand } from '@hermes/kernel';
import type { Goal } from '@hermes/planner';
import type { ModelMessage, TokenUsage } from '@hermes/model';

export type SessionId = Brand<string, 'SessionId'>;

export function toSessionId(raw: string): SessionId {
  return raw as SessionId;
}

/**
 * What an agent is asked to do.
 *
 * `input` is `unknown` and stays that way: the framework never interprets it, and
 * an agent that wants structure declares a `Validator` the way a kernel tool
 * does. Typing it as a string would bake in "agents take prose", which is true of
 * a chat agent and false of a classifier.
 */
export interface AgentRequest {
  /** What is being asked, in whatever shape the agent understands. */
  readonly input: unknown;
  /**
   * Whose request this is, in `@hermes/memory`'s sense.
   *
   * Opaque here — the framework has no user model. Carried so a reasoner can
   * scope a memory lookup, and so a decision records who it was for.
   */
  readonly subject?: string;
  /** Structured facts a reasoner may use. Never interpreted by the framework. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A request to run a tool. **Not a tool call.**
 *
 * The distinction is the subsystem. This is a *description* of work the agent
 * would like done, handed to something else. `@hermes/model`'s `ToolCall` is what
 * a model asked for; this is what the agent decided to ask for, after whatever
 * filtering, validation or substitution the agent applied. They are usually
 * one-to-one and are still different things — an agent may drop a model's call,
 * rewrite its arguments, or invent one the model never suggested.
 */
export interface ToolRequest {
  /** Correlates this request with its observation. Unique within a decision. */
  readonly id: string;
  /** The capability to run, in the kernel's vocabulary. */
  readonly name: string;
  readonly kind: 'tool' | 'agent';
  readonly args: unknown;
  /** Why the agent wants this. For humans, and for an approval gate. */
  readonly reason?: string;
}

/**
 * What came back from a tool the agent asked for.
 *
 * Carries the failure rather than throwing it, and that is deliberate: a tool
 * failing is *information the agent should reason about* — retry differently, try
 * another approach, give up and explain — not an exception that ends the session.
 * A session that threw on the first failed tool could never recover from one.
 */
export interface ToolObservation {
  /** The {@link ToolRequest.id} this answers. */
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  /** What it returned, when `ok`. */
  readonly result?: unknown;
  /** Why it did not, when not `ok`. Flattened; a live Error is not data. */
  readonly error?: { readonly message: string; readonly code?: string };
}

/**
 * What an agent decided. The framework's only output.
 *
 * A discriminated union rather than an object with optional fields, because the
 * variants are genuinely exclusive: "here is your answer" and "please run these
 * tools" are different futures, and a shape that allowed both would need a rule
 * about which wins — a rule every consumer would have to know and one of them
 * would get wrong.
 */
export type AgentDecision =
  AnswerDecision | ToolsDecision | PlanDecision | DelegateDecision | AbstainDecision;

/** Done. Here is the result. */
export interface AnswerDecision {
  readonly kind: 'answer';
  readonly content: unknown;
  /** Why, in one line. Free-form, human-facing, never parsed. */
  readonly rationale?: string;
  /** How much the agent trusts this, in [0,1]. Advisory; see {@link AgentResult}. */
  readonly confidence?: number;
  readonly usage?: TokenUsage;
}

/**
 * Run these, then ask me again.
 *
 * The agent does not run them and does not wait. Something else — an
 * {@link AgentExecutor} the host wires to the execution engine — runs them and
 * hands back {@link ToolObservation}s, and the session asks the agent to decide
 * again with those in hand.
 */
export interface ToolsDecision {
  readonly kind: 'tools';
  readonly requests: readonly ToolRequest[];
  readonly rationale?: string;
  readonly usage?: TokenUsage;
}

/**
 * This needs a plan.
 *
 * The agent hands a goal *back*, and does not call the planner itself. That
 * keeps the dependency one-way — the framework depends on the planner's types,
 * never the planner on the framework — and it keeps the expensive thing (a
 * multi-step plan, possibly a model call) an explicit decision a host can gate,
 * cost, or refuse, rather than something that happens inside a reasoner.
 */
export interface PlanDecision {
  readonly kind: 'plan';
  readonly goal: Goal;
  readonly rationale?: string;
  readonly usage?: TokenUsage;
}

/**
 * Not mine — give it to that agent.
 *
 * How a specialist says so, and how a router agent works. The named agent is
 * looked up in the registry by the session, not by the agent: an agent holding a
 * registry could call another agent directly, and then the hand-off would be a
 * call stack rather than a decision anybody could see.
 */
export interface DelegateDecision {
  readonly kind: 'delegate';
  readonly agent: string;
  /** What to ask it. Defaults to the request this agent received. */
  readonly request?: AgentRequest;
  readonly rationale?: string;
}

/**
 * Not mine, and I have no suggestion.
 *
 * A normal outcome, not a failure — the same distinction `PlanStrategy` draws
 * (RFC-0003 §5.1). It is what makes a chain of agents a chain of responsibility
 * rather than a list of things that error, and it is why `AgentChain` needs no
 * special protocol beyond the union.
 */
export interface AbstainDecision {
  readonly kind: 'abstain';
  readonly reason?: string;
}

/** One turn of a session: what was decided, and what came of it. */
export interface SessionTurn {
  /** 1 on the first decision. */
  readonly turn: number;
  /** Which agent decided. Changes across a delegation. */
  readonly agent: string;
  readonly decision: AgentDecision;
  /** What the tools returned, when the decision asked for tools. */
  readonly observations?: readonly ToolObservation[];
  readonly at: number;
}

/**
 * How a session ended.
 *
 * `settled` is the fact; `reason` is why. Separated because "the agent answered"
 * and "the agent ran out of turns" both end a session and mean opposite things,
 * and a caller that only saw `content` could not tell them apart.
 */
export type SessionOutcome =
  /** The agent answered. */
  | 'answered'
  /** The agent, or the last agent in a chain, had nothing to offer. */
  | 'abstained'
  /** The agent asked for a plan and the session was told to stop there. */
  | 'planned'
  /** The turn budget ran out mid-reasoning. See {@link AgentResult.turns}. */
  | 'exhausted'
  /** The caller aborted. */
  | 'cancelled';

/**
 * What a session produced.
 *
 * The whole transcript, not just the answer. A session that took six turns and
 * two tool calls to answer is something an operator has to be able to read, and
 * an answer with no account of how it was reached is exactly the output nobody
 * lets run unattended.
 */
export interface AgentResult {
  readonly sessionId: SessionId;
  readonly outcome: SessionOutcome;
  /** The final decision. Always present; `abstain` when nothing was offered. */
  readonly decision: AgentDecision;
  /** Every turn, in order. */
  readonly turns: readonly SessionTurn[];
  /** Summed across every model call any reasoner made. Absent if none reported. */
  readonly usage?: TokenUsage;
  readonly startedAt: number;
  readonly finishedAt: number;
}

/**
 * What an agent declares about itself, for routing.
 *
 * `tags` is the socket the kernel left open: it carries `Agent.capabilities` as
 * "free-form capability tags... for routing layers built above it; it never reads
 * them itself" (kernel `agent.ts`). This is that routing layer.
 */
export interface AgentCapability {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/**
 * The conversation an agent is reasoning about, in model terms.
 *
 * Carried on the context rather than rebuilt per reasoner, because a chain of
 * three reasoners must agree on what was said — and each rebuilding it from the
 * turns would be three chances to disagree. A rule-based reasoner ignores it
 * entirely, which costs nothing.
 */
export type Transcript = readonly ModelMessage[];
