/**
 * The bridge between the agent framework and the tools.
 *
 * `@hermes/agent` decides *what should happen* and hands the host a batch of
 * `ToolRequest`s; it never runs them. This is the host's side of that port: it
 * runs each request against the matching tool and returns observations. It is
 * the "~20 lines a bot writes" the framework docs describe — the framework ships
 * only a kernel-backed executor, and a chat bot has no kernel `Runtime`.
 *
 * A failing tool is an `ok: false` observation, never a thrown error: a tool
 * failing is information the agent should reason about (retry, try another
 * approach, explain), not something that ends the session.
 */

import { failedObservation } from '@hermes/agent';
import type {
  AgentExecutor,
  AvailableCapability,
  ToolObservation,
  ToolRequest,
} from '@hermes/agent';
import type { Logger } from '@hermes/kernel';
import { callTool, describe } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

export interface ExecutorDeps {
  readonly logger?: Logger;
}

/**
 * An `AgentExecutor` over a fixed set of tools.
 *
 * `available()` describes the tools so the reasoner can tell the model what
 * exists — `describe()` returns a shape structurally identical to
 * `AvailableCapability`, so it crosses with no adapter. `execute()` runs each
 * request through `callTool`, which validates the model's arguments against the
 * tool's schema exactly the way the kernel would.
 */
export function toolExecutor(
  tools: readonly HermesTool[],
  deps: ExecutorDeps = {},
): AgentExecutor {
  const byName = new Map<string, HermesTool>(tools.map((tool) => [tool.name, tool]));
  const capabilities: readonly AvailableCapability[] = tools.map((tool) =>
    describe(tool),
  );

  const run = async (request: ToolRequest): Promise<ToolObservation> => {
    const tool = byName.get(request.name);
    if (tool === undefined) {
      return failedObservation(request, new Error(`unknown tool: ${request.name}`));
    }
    try {
      const result = await callTool(tool, request.args, {
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      });
      return { id: request.id, name: request.name, ok: true, result };
    } catch (thrown) {
      deps.logger?.warn('tool failed', {
        tool: request.name,
        error: (thrown as Error).message,
      });
      return failedObservation(request, thrown);
    }
  };

  return {
    available: () => capabilities,
    execute: (requests) => Promise.all(requests.map(run)),
  };
}
