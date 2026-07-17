/**
 * Testing utilities — shipped, not test-only.
 *
 * These are in `src`, exported from the package, and part of the public API. That
 * is deliberate: **the people who most need them do not live in this repository.**
 * A plugin author writing a tool needs a `ToolContext` to call it with, and the
 * kernel does not export one — it builds contexts privately inside
 * `Runtime.#execute`. Without this, every tool author's first act is to
 * hand-roll a fake context, get `signal` wrong, and discover at 3am that their
 * tool never honoured cancellation because their tests never gave it a signal
 * that aborts.
 *
 * The cost is honest and small: a few hundred bytes of test helpers ship in
 * `dist`. The alternative — a `@hermes/tools/testing` subpath export — buys
 * nothing at this size and costs a second entry point to keep working.
 */

import { systemClock, noopLogger, toMissionId, toTaskId } from '@hermes/kernel';
import type { Clock, Logger, ToolContext } from '@hermes/kernel';
import type { Tool } from '@hermes/kernel';

export interface TestContextOptions {
  readonly taskName?: string;
  /** 1 on the first try, as the kernel reports it. */
  readonly attempt?: number;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/**
 * A `ToolContext`, as the kernel would build one.
 *
 * Every field is real rather than `undefined as never`: a tool that reads
 * `ctx.logger` in a test should get a logger, not a crash, and one that reads
 * `ctx.signal` should get a signal that behaves — which is what makes it possible
 * to test that a tool honours cancellation at all.
 */
export function testContext(options: TestContextOptions = {}): ToolContext {
  return {
    missionId: toMissionId('mission_test'),
    taskId: toTaskId('task_test'),
    taskName: options.taskName ?? 'test',
    attempt: options.attempt ?? 1,
    // A fresh, un-aborted signal by default. `undefined as never` would let a
    // tool that never checks its signal pass every test and hang in production.
    signal: options.signal ?? new AbortController().signal,
    clock: options.clock ?? systemClock,
    logger: options.logger ?? noopLogger,
  };
}

/**
 * Call a tool exactly the way the kernel does.
 *
 * The body mirrors `runtime.ts` `#invokeTool` line for line — parse the input,
 * execute, parse the output — and that correspondence is the whole value. A test
 * that called `tool.execute(input, ctx)` directly would skip both validators, and
 * the validators are the half of a tool most worth testing, because the input
 * came from a model and the output is what the model reads next.
 *
 * The output half is easy to leave out, and this package nearly did: an earlier
 * draft asserted the kernel did not validate output at all. It does. A helper
 * that skipped it would let a tool pass every test and fail on a real runtime,
 * which is the exact opposite of what a testing utility is for.
 *
 * `input` is `unknown` on purpose, so a test can pass the malformed thing a model
 * would send rather than only the well-typed thing TypeScript allows.
 */
export async function callTool<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  input: unknown,
  options: TestContextOptions = {},
): Promise<TOutput> {
  const ctx = testContext({ taskName: tool.name, ...options });
  // The cast is the honest one: a tool with no declared validator has no way to
  // turn `unknown` into `TInput`, and the kernel makes exactly the same leap
  // (`const input = tool.input ? tool.input.parse(rawInput) : rawInput`). A tool
  // that wants the check declares a schema — which is the framework's whole
  // argument, and a test helper that pretended otherwise would be testing a
  // safety that production does not have.
  const parsed = tool.input ? tool.input.parse(input) : (input as TInput);
  const output = await tool.execute(parsed, ctx);
  return tool.output ? tool.output.parse(output) : output;
}

/**
 * Assert that a tool's declaration is coherent, and return what is wrong.
 *
 * A conformance suite a plugin author runs against their own tool. It checks the
 * things that are *technically legal* and always mistakes — a tool that declares
 * examples violating its own schema, a description too short to choose by — none
 * of which the type system can catch and all of which surface as a model
 * behaving badly, which is the hardest failure to trace back to its cause.
 *
 * Returns the problems rather than throwing, so a test can assert on the list and
 * a host can log it at boot without refusing to start.
 */
export function auditTool(tool: Tool): readonly string[] {
  const issues: string[] = [];
  const hermes = tool as {
    examples?: readonly { input: unknown; description: string }[];
  };

  if (tool.description.trim().length < 10) {
    issues.push(
      `description is ${String(tool.description.trim().length)} characters; a model reads it ` +
        `to choose this tool over another`,
    );
  }

  if (tool.input === undefined) {
    // Not an error. A tool that genuinely takes nothing is fine — but it should
    // say so with `nothing()`, because "no schema" and "no arguments" read
    // identically to a host and differently to a model.
    issues.push(
      'declares no input schema, so a model is told nothing about its arguments; ' +
        'use `nothing()` if it truly takes none',
    );
  }

  // The check that earns this function. An example that violates the schema is
  // documentation actively teaching a model to make a call that will be rejected.
  for (const [index, example] of (hermes.examples ?? []).entries()) {
    if (tool.input === undefined) continue;
    try {
      tool.input.parse(example.input);
    } catch (thrown) {
      issues.push(
        `example ${String(index)} ("${example.description}") does not match the input schema: ` +
          (thrown as Error).message,
      );
    }
  }

  return issues;
}

/**
 * A tool that records what it was called with.
 *
 * For testing the layers *above* a tool — a middleware, a catalog, an agent — where
 * what matters is that the call arrived, with what, and how often.
 */
export function spyTool<TOutput>(
  name: string,
  result: TOutput,
  overrides: Partial<Tool<never, TOutput>> = {},
): Tool<never, TOutput> & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    description: `A recording stand-in for ${name}`,
    calls,
    execute: (input: never) => {
      calls.push(input);
      return Promise.resolve(result);
    },
    ...overrides,
  };
}
