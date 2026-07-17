/**
 * Tool — a named, callable capability with no memory.
 *
 * A tool is the smallest unit the kernel can execute: give it input, get output.
 * "Send an email", "query the calendar", "read a file". It does not decide when
 * to run or what to run next; something else does that.
 *
 * The kernel never imports a tool. Tools arrive through plugins and are looked
 * up by name, which is the whole reason a mission can be a plain data structure:
 * `{ kind: 'tool', name: 'calendar.list' }` is serialisable, a function is not.
 */

import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import type { MissionId, TaskId } from './ids.js';

/**
 * Anything that can turn `unknown` into a `T` or throw trying.
 *
 * Structurally compatible with a Zod schema, so a plugin can pass `z.object(...)`
 * directly — but the kernel takes no dependency on Zod, or on any validation
 * library. That choice belongs to whoever writes the tool.
 */
export interface Validator<T> {
  parse(input: unknown): T;
}

/** What the kernel hands to a tool or agent while it runs. */
export interface ExecutionContext {
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly taskName: string;
  /** 1 on the first try. */
  readonly attempt: number;
  /**
   * Aborts on task timeout, mission cancellation, or runtime shutdown.
   * Long-running work is expected to honour it.
   */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly clock: Clock;
}

export type ToolContext = ExecutionContext;

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  /** Optional gate. Given one, the kernel parses input before calling `execute`. */
  readonly input?: Validator<TInput>;
  readonly output?: Validator<TOutput>;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

/**
 * A tool of unknown shape, for heterogeneous storage.
 *
 * `unknown` rather than `any`: every concrete `Tool<I, O>` is assignable to it —
 * `execute` because method parameters are bivariant, `input`/`output` because a
 * `Validator<I>` returns `I`, which is always an `unknown`. So the registry
 * accepts any tool, and the call site handles `unknown` input honestly instead
 * of `any` quietly disabling the checker everywhere it spreads.
 *
 * The bivariance is the unsound part, and it is deliberate: a heterogeneous
 * registry cannot be typed otherwise. {@link Validator} is what makes it safe at
 * runtime — a tool that declares `input` gets its unknown checked before it runs.
 */
export type AnyTool = Tool;

/** The tool surface handed to an agent. */
export interface ToolAccess {
  has(name: string): boolean;
  list(): readonly { readonly name: string; readonly description: string }[];
  /**
   * Invoke a tool by name. Returns `unknown` on purpose: the caller knows what it
   * asked for and narrows deliberately, rather than a fake generic asserting a
   * type nobody checked.
   */
  invoke(name: string, input: unknown): Promise<unknown>;
}

/** Small helper that keeps a tool's declaration inferring its own types. */
export function defineTool<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return tool;
}
