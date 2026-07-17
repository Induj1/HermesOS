/**
 * The execution port: how a tool request becomes an observation.
 *
 * ## This interface is where the subsystem boundary is drawn
 *
 * The framework decides what should happen and **does not own execution**. But a
 * session has to close the loop somehow — an agent that asks for tools and never
 * hears back cannot take a second turn — so the loop needs *someone* to run
 * them. This is the shape of that someone, declared here, in the framework's
 * terms, and implemented outside it.
 *
 * The distinction that makes this honest rather than a fig leaf: the framework
 * owns the **interface**, never an implementation. There is no
 * `KernelAgentExecutor` in this package. A host wires one to `@hermes/execution`
 * or to a kernel `Runtime`, and the framework cannot tell which — it cannot even
 * tell whether anything ran, only what came back.
 *
 * ## Why it is not `ToolAccess`
 *
 * The kernel has an interface for exactly this: `ToolAccess`, with
 * `invoke(name, input)`. It is deliberately not reused, for two reasons.
 *
 * It only reaches tools. `ToolRequest.kind` may be `agent`, and the kernel gives
 * an agent no way to invoke another agent (`runtime.ts` `#toolAccess`) — so a
 * port shaped like `ToolAccess` could not express half of what an agent decides.
 *
 * And it throws. A tool failing is *information an agent should reason about*
 * (see {@link ToolObservation}), so this returns observations and never rejects
 * for a tool's own failure. A port that threw would make the session's error
 * handling the place where "the search returned nothing" gets decided, which is
 * the agent's job.
 */

import type { ToolObservation, ToolRequest } from '../model.js';

export interface AgentExecutor {
  /**
   * Run these requests and report what happened.
   *
   * **Takes the whole batch, not one request.** A decision asking for three
   * independent lookups should get three concurrent lookups, and only the
   * implementation knows what may run together — the execution engine has a
   * concurrency budget and a scheduler; this framework has neither and must not
   * pretend to by looping.
   *
   * Returns one observation per request, in the same order. A failing tool is a
   * `ok: false` observation, not a rejection: **this rejects only when it could
   * not run anything at all** — the runtime is stopped, the caller aborted.
   * That distinction is what lets a session tell "the tool said no" from "there
   * is nothing to run tools with".
   */
  execute(
    requests: readonly ToolRequest[],
    signal?: AbortSignal,
  ): Promise<readonly ToolObservation[]>;

  /**
   * What can be run, so a reasoner can be told what exists.
   *
   * Read-only and descriptive. A reasoner is told *that* a capability exists and
   * is never handed the ability to run one — the same split `@hermes/model` draws
   * between `ToolDefinition` and `ToolCall`, kept consistent so an
   * `LlmReasoner` can pass one straight to the other.
   */
  available(): readonly AvailableCapability[];
}

export interface AvailableCapability {
  readonly name: string;
  readonly kind: 'tool' | 'agent';
  readonly description: string;
  /** JSON Schema for the arguments, when the capability declares one. */
  readonly parameters?: unknown;
  /** Free-form tags, for a {@link ToolSelectionStrategy} that filters on them. */
  readonly tags?: readonly string[];
}
