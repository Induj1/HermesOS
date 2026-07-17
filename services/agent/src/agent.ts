/**
 * Agent — identity plus a reasoner.
 *
 * ## The whole class model, in one sentence
 *
 * An agent **is** a name, a description, some tags, and a {@link Reasoner}. It has
 * no `reason` method of its own and no subclasses. "The same agent thinking
 * differently" is a field swap; "a different agent thinking the same way" is two
 * agents sharing a reasoner.
 *
 * That is composition over inheritance taken literally, and it is worth being
 * explicit about what it avoids. The obvious design is `abstract class Agent` with
 * `LlmAgent`, `RuleAgent`, `CompositeAgent` beneath it. It reads well and it
 * fuses two things that vary independently: *who this agent is* and *how it
 * thinks*. Under that design, giving a rule-based agent a model means constructing
 * a different class, re-registering it under the same name, and hoping nothing
 * held a reference to the old one. Here it is one field.
 *
 * It also makes the four agent kinds the objectives ask for stop being kinds:
 *
 * | asked for | what it is here |
 * | --- | --- |
 * | deterministic agent | an agent whose reasoner is `RuleBasedReasoner` |
 * | AI-powered agent | an agent whose reasoner is `LlmReasoner` |
 * | composite agent | an agent whose reasoner is `ReasonerChain` |
 * | specialist agent | an agent with narrow `tags` that abstains readily |
 *
 * None of them needed a class. See RFC-0005 §5.1.
 */

import type { Reasoner } from './ports/reasoner.js';
import type { ToolSelectionStrategy } from './ports/tool-selection.js';

export interface Agent {
  /** Unique within a registry. How a `DelegateDecision` names it. */
  readonly name: string;
  /**
   * What it is for, in one line.
   *
   * Required, not optional, and for the same reason `PlanStep.intent` is
   * (RFC-0003 §6): it is what a *router* reads to choose this agent and what a
   * model is told when this agent is offered as a capability. An agent that
   * cannot describe itself cannot be selected by anything but its name.
   */
  readonly description: string;
  /**
   * Free-form routing tags.
   *
   * The socket the kernel left open — it carries `Agent.capabilities` as tags
   * "for routing layers built above it; it never reads them itself" (kernel
   * `agent.ts`). This is that layer. The framework does not read them either; a
   * router built on top does.
   */
  readonly tags?: readonly string[];
  /** The brain. Replaceable without touching anything above. */
  readonly reasoner: Reasoner;
  /**
   * Which capabilities this agent is told about.
   *
   * Per-agent rather than per-runtime, because it is a property of the agent:
   * a summariser has no business seeing the payment tools, and saying so once
   * here is better than a policy engine consulted on every turn.
   *
   * Defaults to being told about everything. That default is right for a
   * deterministic agent, which ignores the list, and wrong for a model-backed one
   * with sixty tools registered — so `LlmReasoner`'s docs say to set it and
   * RFC-0005 §7.2 records the tension rather than pretending the default scales.
   */
  readonly tools?: ToolSelectionStrategy;
}

/**
 * Declare an agent.
 *
 * Sugar, and it earns its place the way `defineTool` does: it keeps the
 * declaration inferring its own types and gives a stable shape to grep for. It
 * validates nothing, because there is nothing here to validate that the type
 * system has not already checked.
 */
export function defineAgent(agent: Agent): Agent {
  return agent;
}

/**
 * What an agent declares about itself.
 *
 * Derived rather than stored, so it cannot drift from the agent it describes —
 * the alternative is a `capability` field somebody forgets to update when the
 * description changes.
 */
export function capabilityOf(agent: Agent): {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
} {
  return {
    name: agent.name,
    description: agent.description,
    tags: agent.tags ?? [],
  };
}
