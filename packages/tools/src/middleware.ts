/**
 * Tool middleware — what wraps a call.
 *
 * The same shape as `@hermes/agent`'s `AgentMiddleware`, deliberately: one idea,
 * learned once. The difference is where it sits and therefore what it can do.
 *
 * | | agent middleware | tool middleware |
 * | --- | --- | --- |
 * | wraps | a *decision* | an *effect* |
 * | can refuse | before anything happened | before this call happens |
 * | sees | what the agent wants | what it was actually given |
 *
 * Both are needed and neither replaces the other. An agent middleware guards what
 * an agent *intends*, which is the cheapest place to say no — but it only sees
 * agents. A tool middleware guards the tool itself, so it also catches the call a
 * plan made directly, a host made in a script, or another tool made in a
 * composition. Defence at the boundary that owns the effect.
 */

import type { ToolContext } from '@hermes/kernel';
import { assertPermitted, type PermissionSet } from './permissions.js';
import type { AnyHermesTool, HermesTool } from './tool.js';

/** The next link. Calling it runs the rest of the chain and then the tool. */
export type NextCall<TInput, TOutput> = (
  input: TInput,
  ctx: ToolContext,
) => Promise<TOutput>;

/**
 * Wrap a tool call.
 *
 * `input` is passed on rather than closed over, so a middleware can rewrite it —
 * redacting a secret before it reaches a logger, or rooting a path before it
 * reaches the filesystem.
 */
export type ToolMiddleware<TInput = never, TOutput = unknown> = (
  input: TInput,
  ctx: ToolContext,
  next: NextCall<TInput, TOutput>,
) => Promise<TOutput>;

/**
 * Wrap a tool in middleware.
 *
 * The **first** middleware is the outermost — it sees the call first and the
 * result last. That is the order everyone means by "middleware" and the opposite
 * of what a naive `reduce` produces, which is why this reduces from the right.
 *
 * Returns a `HermesTool` with **the same name and the same metadata**, so a
 * wrapped tool registers exactly where the unwrapped one would and nothing
 * downstream can tell. In particular the schema survives, or a wrapped tool would
 * silently stop telling models what it takes — which is the bug this whole
 * package exists to prevent, reintroduced by its own middleware.
 */
export function withMiddleware<TInput, TOutput>(
  tool: HermesTool<TInput, TOutput>,
  middleware: readonly ToolMiddleware<TInput, TOutput>[],
): HermesTool<TInput, TOutput> {
  if (middleware.length === 0) return tool;

  const wrapped = [...middleware].reverse().reduce<NextCall<TInput, TOutput>>(
    (next, layer) => (input, ctx) => layer(input, ctx, next),
    (input, ctx) => tool.execute(input, ctx),
  );

  return { ...tool, execute: async (input, ctx) => await wrapped(input, ctx) };
}

/**
 * Guard a tool with the permissions it declares.
 *
 * The enforcement half of `permissions.ts`. It is a wrapper rather than a check
 * inside `defineTool` because the grant is a property of the **host**, not of the
 * tool: a tool that checked its own permissions would need the grant at
 * declaration time, before a host exists to have decided one. As a wrapper it is
 * applied at wiring, where the grant is known, and a host that trusts its tools
 * simply does not apply it.
 *
 * ```ts
 * const guarded = withPermissions(writeFile, PermissionSet.none());
 * ```
 *
 * ## Why there is no standalone permission `ToolMiddleware`
 *
 * There was, and it could not work. A `ToolMiddleware` receives the kernel's
 * `ToolContext`, which carries `taskName` and **no reference to the tool** — so a
 * middleware has no way to ask "what does this tool declare?" and would have to
 * be constructed per tool anyway. Shipping one that read an empty list and
 * therefore permitted everything would have been a guard that fails open, which
 * is the worst thing a guard can be. This closes over the real declaration
 * instead.
 */
export function withPermissions<TInput, TOutput>(
  tool: HermesTool<TInput, TOutput>,
  granted: PermissionSet,
): HermesTool<TInput, TOutput> {
  if (tool.permissions === undefined || tool.permissions.length === 0) return tool;

  return withMiddleware(tool, [
    async (input, ctx, next) => {
      // Checked on every call rather than once at wiring, and that is not
      // paranoia: `PermissionSet` is immutable, but a host may legitimately wrap
      // the same tool under different grants for different agents, and the check
      // belongs to the call it guards.
      assertPermitted(tool.name, tool.permissions, granted);
      return await next(input, ctx);
    },
  ]);
}

/**
 * Every tool in a set, guarded by one grant.
 *
 * Sugar, and it is the shape a host actually wants: permissions are decided once,
 * for a whole toolset, at the composition root. Guarding tools one at a time is
 * how one gets forgotten.
 */
export function withPermissionsAll(
  tools: readonly AnyHermesTool[],
  granted: PermissionSet,
): readonly AnyHermesTool[] {
  return tools.map((tool) => withPermissions(tool, granted));
}
