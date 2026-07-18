/**
 * The agent and its runtime — the reasoning half, wired to a model and an
 * executor but to nothing impure. `main.ts` builds the model (Ollama) and the
 * executor (real tools) and hands them here; a test hands a fake model and an
 * in-memory executor and drives the exact same loop.
 */

import { AgentRuntime, defineAgent, LlmReasoner } from '@hermes/agent';
import type { AgentExecutor, AgentResult } from '@hermes/agent';
import type { Clock, Logger } from '@hermes/kernel';
import type { ChatModel, ToolCallingModel } from '@hermes/model';

export const AGENT_NAME = 'assistant';

const SYSTEM_PROMPT = [
  'You are Hermes, a capable software agent reachable over Telegram.',
  'You have real tools and you USE them rather than describing them: read and',
  'write files in your workspace, make HTTP requests, and run shell commands',
  '(node, npm, npx, pnpm, git, mkdir, and more).',
  'When asked to build or make something — a website, a script, a project — do',
  'NOT reply with what you "can" or "cannot" do. Just start doing it: create the',
  'files, run the commands, and iterate until it works.',
  'Write real code to files with your file tools, and use the shell to scaffold,',
  'install dependencies, run builds, and check your work.',
  'You cannot host a long-running dev server (each command must finish), so build',
  'and save the project, then tell the user the file paths and how to run it.',
  'Report what you actually did — the commands you ran and the files you wrote,',
  'with paths. Keep replies short enough to read on a phone.',
].join(' ');

export interface AgentRuntimeDeps {
  readonly model: ChatModel | ToolCallingModel;
  readonly executor: AgentExecutor;
  readonly maxTurns?: number;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/** Build a single-agent runtime: an LLM reasoner over the given model, with the
 *  given executor closing the tool loop. */
export function buildAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return new AgentRuntime({
    executor: deps.executor,
    maxTurns: deps.maxTurns ?? 6,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    agents: [
      defineAgent({
        name: AGENT_NAME,
        description:
          'A general assistant that reads and writes workspace files, makes HTTP ' +
          'requests, and runs allowlisted shell commands to carry out tasks.',
        reasoner: new LlmReasoner({
          model: deps.model,
          systemPrompt: () => SYSTEM_PROMPT,
        }),
      }),
    ],
  });
}

/**
 * Turn a finished session into a line of text to send back to the chat.
 *
 * The agent's decision is a union, and every arm has to become *something* a
 * person reads on a phone — an answer is the answer; anything else is an honest
 * account of why there is no answer, rather than silence.
 */
export function replyText(result: AgentResult): string {
  const decision = result.decision;
  switch (decision.kind) {
    case 'answer':
      return render(decision.content);
    case 'abstain':
      return decision.reason ?? "I don't have an answer for that.";
    case 'plan':
      return 'That needs a plan I cannot carry out from here yet.';
    case 'delegate':
      return `That is better handled by another agent (${decision.agent}).`;
    case 'tools':
      // A 'tools' decision is the final one only when the turn budget ran out
      // mid-loop — otherwise the session would have run them and asked again.
      return result.outcome === 'exhausted'
        ? "I couldn't finish within the step budget — try narrowing the task."
        : 'I still need to run some tools to answer that.';
  }
}

function render(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}
