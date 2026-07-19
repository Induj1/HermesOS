/**
 * A team of specialist agents behind one coordinator.
 *
 * The coordinator's reasoner is a chain: a keyword router first, the general LLM
 * behind it. The router emits a `delegate` decision to a specialist when the
 * request clearly fits one; otherwise it abstains and the coordinator answers
 * directly. Each specialist is the same model with a focused system prompt, so
 * "plan my launch" gets a planner's mindset and "build a site" gets a builder's
 * — the framework runs the delegated agent and returns its answer.
 *
 * Specialists use a plain LLM reasoner (no router), so there is no delegation
 * loop. Tools, memory, and the turn budget are shared at the runtime level.
 */

import { AgentRuntime, LlmReasoner, ReasonerChain, defineAgent } from '@hermes/agent';
import type {
  AgentContext,
  AgentDecision,
  AgentExecutor,
  AgentRequest,
  MemoryAdapter,
  Reasoner,
} from '@hermes/agent';
import type { Clock, Logger } from '@hermes/kernel';
import type { ChatModel, ToolCallingModel } from '@hermes/model';
import { systemPromptWithHistory } from './conversation.js';

export const COORDINATOR = 'assistant';
export type Specialist = 'researcher' | 'coder' | 'planner';

const COORDINATOR_PROMPT =
  'You are Hermes, a capable assistant on Telegram. Use your tools rather than ' +
  'describing them. When you have enough to answer, reply in plain text, short ' +
  'enough to read on a phone.';

const SPECIALIST_PROMPTS: Record<Specialist, string> = {
  researcher:
    'You are Hermes-Researcher. Answer by gathering facts: use the http tools to ' +
    'fetch pages and APIs, read files when relevant, and synthesise a clear answer. ' +
    'Say where a fact came from. Keep it short enough for a phone.',
  coder:
    'You are Hermes-Coder. Build things: write real code to files and use the shell ' +
    '(node, npm, npx, pnpm, git) to scaffold, install, and build. Use relative ' +
    'workspace paths and create a folder with fs.mkdir before writing into it. When ' +
    'done, report the files you wrote and how to run them.',
  planner:
    'You are Hermes-Planner. Break the request into a short, ordered, numbered plan ' +
    'of concrete steps. Do NOT execute anything — just produce the plan, concisely.',
};

/** Which specialist (if any) a request should be routed to. */
export function routeTo(input: string): Specialist | undefined {
  const text = input.toLowerCase();
  if (/\b(plan|steps?|roadmap|break (it|this) down|outline|strateg)/.test(text))
    return 'planner';
  if (
    /\b(build|code|create|make|write|scaffold|app|website|site|script|program|implement|fix|debug|refactor)/.test(
      text,
    )
  ) {
    return 'coder';
  }
  if (
    /\b(research|find|look up|search|latest|news|who is|what is|fetch|scrape|summar)/.test(
      text,
    )
  ) {
    return 'researcher';
  }
  return undefined;
}

/** Reasoner that delegates to a specialist by keyword, or abstains. */
export class RouterReasoner implements Reasoner {
  readonly name = 'router';

  reason(request: AgentRequest, _ctx: AgentContext): Promise<AgentDecision> {
    const input =
      typeof request.input === 'string' ? request.input : JSON.stringify(request.input);
    const to = routeTo(input);
    if (to === undefined) return Promise.resolve({ kind: 'abstain' });
    return Promise.resolve({
      kind: 'delegate',
      agent: to,
      rationale: `routed to ${to}`,
    });
  }
}

export interface TeamRuntimeDeps {
  readonly model: ChatModel | ToolCallingModel;
  readonly executor: AgentExecutor;
  readonly maxTurns?: number;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly memory?: MemoryAdapter;
  readonly recall?: number;
}

/** Build a coordinator + researcher/coder/planner team in one runtime. */
export function buildTeamRuntime(deps: TeamRuntimeDeps): AgentRuntime {
  const recall = deps.memory === undefined ? 0 : (deps.recall ?? 5);
  const llm = (prompt: string): LlmReasoner =>
    new LlmReasoner({
      model: deps.model,
      systemPrompt: systemPromptWithHistory(prompt),
      recall,
    });
  const specialist = (name: Specialist, description: string) =>
    defineAgent({ name, description, reasoner: llm(SPECIALIST_PROMPTS[name]) });

  return new AgentRuntime({
    executor: deps.executor,
    maxTurns: deps.maxTurns ?? 12,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.memory === undefined ? {} : { memory: deps.memory }),
    agents: [
      defineAgent({
        name: COORDINATOR,
        description: 'Coordinator that routes to a specialist or answers directly.',
        reasoner: new ReasonerChain([new RouterReasoner(), llm(COORDINATOR_PROMPT)]),
      }),
      specialist('researcher', 'Gathers facts from the web and files.'),
      specialist('coder', 'Builds and edits code and projects.'),
      specialist('planner', 'Breaks a task into an ordered plan.'),
    ],
  });
}
