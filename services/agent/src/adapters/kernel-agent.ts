/**
 * Where the two meanings of "agent" meet.
 *
 * The kernel has an `Agent` and so does this framework, and they are different
 * things wearing the same word:
 *
 * | | kernel `Agent` | framework `Agent` |
 * | --- | --- | --- |
 * | is handed | the tool registry | nothing that can act |
 * | does | calls tools, returns a value | returns a decision |
 * | lives | inside one kernel task | across a session of turns |
 *
 * **This file is the only place they touch.** Everywhere else they stay apart,
 * and that is what keeps "agents never execute tools directly" true while the
 * kernel's agents go on executing tools, which is their job.
 *
 * ## What the adapter actually does
 *
 * It runs a whole session — decisions, tools, turns, delegation — inside a single
 * kernel task, and returns the answer. So from the kernel's side, `summariser` is
 * one agent that takes input and returns output, exactly like any other; and from
 * the framework's side nothing changed, because the session drove the loop the
 * way it always does.
 *
 * The `ToolAccess` the kernel hands the adapter is what the session's
 * `AgentExecutor` uses — see {@link kernelExecutor}. So tools do run, through the
 * kernel, dispatched by the kernel, counted against its concurrency. The
 * framework asked; the kernel acted. That is the arrangement working, not a
 * loophole in it.
 *
 * ## The honest cost
 *
 * A session inside one task is invisible to the scheduler: six model calls and
 * four tools look like one long task, with no per-step retry, no concurrency
 * accounting, and no events. That is exactly the limitation RFC-0001 §11.3 names
 * for agents doing unbounded work in a single task, inherited rather than
 * introduced — and the alternative is available and better when it matters: let
 * the agent return a `PlanDecision` or a `ToolsDecision` and have
 * `@hermes/execution` run the steps as real tasks. See RFC-0005 §7.4.
 */

import { defineAgent as defineKernelAgent } from '@hermes/kernel';
import type {
  Agent as KernelAgent,
  AgentContext as KernelAgentContext,
  ToolAccess,
} from '@hermes/kernel';
import type { AgentRequest, AgentResult } from '../model.js';
import type { AgentExecutor, AvailableCapability } from '../ports/agent-executor.js';
import { failedObservation } from '../session.js';
import type { AgentRuntime } from '../runtime.js';

/**
 * An `AgentExecutor` backed by the kernel's `ToolAccess`.
 *
 * The bridge that lets a framework agent's decisions actually happen, and the
 * one implementation of the port this package ships — which is a deliberate
 * exception to "the framework owns the interface, never an implementation",
 * because it owns no *execution*: every request goes straight to
 * `tools.invoke`, and the kernel does the work.
 *
 * @param tools The kernel's tool surface, from a kernel `AgentContext`.
 */
export function kernelExecutor(tools: ToolAccess): AgentExecutor {
  return {
    available: (): readonly AvailableCapability[] =>
      tools.list().map((tool) => ({
        name: tool.name,
        kind: 'tool',
        description: tool.description,
      })),

    execute: async (requests, signal) => {
      // Concurrent, not sequential. The port promises the *whole batch*
      // precisely so independent lookups run together, and the kernel's
      // concurrency budget is what bounds them — a loop here would serialise
      // work the kernel was ready to parallelise, and no one would see why.
      return await Promise.all(
        requests.map(async (request) => {
          try {
            signal?.throwIfAborted();
            // `kind: 'agent'` cannot be honoured: the kernel gives an agent no
            // way to invoke another agent (`runtime.ts` `#toolAccess`). It is
            // reported as a failed observation rather than thrown, because a
            // model asking for a colleague is a thing that happens and the agent
            // should get to reason about the refusal.
            if (request.kind === 'agent') {
              throw new Error(
                `Cannot invoke agent "${request.name}" from inside a kernel task: the kernel ` +
                  `exposes tools to an agent, not agents. Use a delegate decision instead.`,
              );
            }
            const result = await tools.invoke(request.name, request.args);
            return { id: request.id, name: request.name, ok: true, result };
          } catch (thrown) {
            // A tool failing is information the agent should reason about, not
            // an exception that ends the session.
            return failedObservation(request, thrown);
          }
        }),
      );
    },
  };
}

export interface KernelAgentOptions {
  /** The kernel-facing name. Defaults to the framework agent's own. */
  readonly name?: string;
  readonly description?: string;
  /**
   * What to return when the session does not answer.
   *
   * Default: throw. An agent that abstained or ran out of turns did *not* produce
   * a result, and returning `undefined` would tell the kernel the task succeeded
   * — so a mission would sail on with a step that decided nothing, and the
   * failure would surface somewhere else entirely. A host that genuinely wants a
   * non-answer to be a value says so here.
   */
  onNoAnswer?(result: AgentResult): unknown;
}

/**
 * Expose a framework agent to the kernel.
 *
 * ```ts
 * runtime.use({
 *   name: 'agents',
 *   setup: (ctx) => ctx.registerAgent(asKernelAgent(agents, 'summariser')),
 * });
 * ```
 *
 * @param runtime The agent runtime holding the agent and its wiring.
 * @param agentName Which agent to expose.
 * @throws {AgentNotFoundError} at *registration* time rather than at dispatch —
 *   the same gap the planner exists to close (RFC-0003 §4), closed here for the
 *   same reason: a typo should not wait until a mission has already had half its
 *   effects.
 */
export function asKernelAgent(
  runtime: AgentRuntime,
  agentName: string,
  options: KernelAgentOptions = {},
): KernelAgent {
  const agent = runtime.agents.require(agentName);

  return defineKernelAgent({
    name: options.name ?? agent.name,
    description: options.description ?? agent.description,
    ...(agent.tags === undefined ? {} : { capabilities: agent.tags }),

    handle: async (input: unknown, ctx: KernelAgentContext): Promise<unknown> => {
      // A session per task, wired to *this* task's tool access — so tools run
      // with this task's signal, logger and clock, and are cancelled when it is.
      const session = runtime.session(kernelExecutor(ctx.tools));

      const request: AgentRequest = {
        input,
        metadata: {
          missionId: ctx.missionId,
          taskId: ctx.taskId,
          attempt: ctx.attempt,
        },
      };

      const result = await session.run(agentName, request, { signal: ctx.signal });

      if (result.decision.kind === 'answer') return result.decision.content;

      if (options.onNoAnswer) return options.onNoAnswer(result);

      // Thrown, so the kernel fails the task and its retry, failure policy and
      // events all engage. Returning undefined would claim success for a step
      // that decided nothing.
      throw new Error(
        `Agent "${agentName}" did not answer (${result.outcome}) after ` +
          `${String(result.turns.length)} turn(s)`,
      );
    },
  });
}
