/**
 * Agent — a named handler that may decide things.
 *
 * Structurally an agent is close to a tool: named, takes input, returns output.
 * The difference is authority. A tool executes a fixed effect; an agent is
 * handed the tool registry and chooses what to call.
 *
 * The kernel deliberately says nothing about *how* it chooses. A hand-written
 * if/else, a rules table, and a future model-backed planner all satisfy this
 * interface identically. That is what keeps the kernel free of AI while leaving
 * the socket that AI plugs into.
 */

import type { ExecutionContext, ToolAccess, Validator } from './tool.js';

export interface AgentContext extends ExecutionContext {
  /** Everything the runtime knows how to do, callable by name. */
  readonly tools: ToolAccess;
}

export interface Agent<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  /**
   * Free-form capability tags. The kernel carries them for routing layers built
   * above it; it never reads them itself.
   */
  readonly capabilities?: readonly string[];
  readonly input?: Validator<TInput>;
  handle(input: TInput, ctx: AgentContext): Promise<TOutput>;
}

/** See {@link AnyTool} for why this is `unknown` rather than `any`. */
export type AnyAgent = Agent;

export function defineAgent<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
): Agent<TInput, TOutput> {
  return agent;
}
