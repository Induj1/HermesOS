/**
 * @hermes/agent — reasoning and decision-making.
 *
 * The kernel decides *when* things run. The planner decides *what the graph is*.
 * Memory decides *what survives*. The execution engine decides *what the steps
 * know*. This decides **what should happen** — and never makes it happen.
 *
 * ## The rule, and how it is enforced
 *
 * An agent's only output is an {@link AgentDecision}: an answer, a request to run
 * tools, a request to plan, a hand-off, or a refusal. There is no variant that
 * says "and I already did it", so a reviewer never has to check whether a new
 * reasoner secretly called a tool — the return type does not let it say so.
 *
 * The same trick runs through every port. A reasoner gets {@link AgentContext},
 * which has no registry (so it cannot invoke another agent), no `MemoryService`
 * (so it cannot write a memory — only {@link MemoryAdapter}, which reads), and no
 * `Runtime` (so it cannot start a mission). Nothing is prevented by convention.
 *
 * ## An agent is identity plus a reasoner
 *
 * That is the whole class model. There is no `LlmAgent` or `RuleAgent` class:
 *
 * | | is |
 * | --- | --- |
 * | deterministic agent | an agent whose reasoner is {@link RuleBasedReasoner} |
 * | AI-powered agent | an agent whose reasoner is {@link LlmReasoner} |
 * | composite agent | an agent whose reasoner is {@link ReasonerChain} |
 * | specialist agent | an agent with narrow `tags` that abstains readily |
 *
 * ## The intended shape of a host
 *
 * ```ts
 * const agents = new AgentRuntime({
 *   executor,                       // wired to @hermes/execution or a kernel task
 *   memory: memoryAdapter(memory),  // read-only; there is no write side
 *   agents: [
 *     defineAgent({
 *       name: 'assistant',
 *       description: 'Answers questions about the day ahead',
 *       // Order is policy: the model first, the rules behind it. When the model
 *       // is down, the rules answer. That is the whole fallback story.
 *       reasoner: new ReasonerChain([
 *         new LlmReasoner({ model }),
 *         new RuleBasedReasoner(myRules),
 *       ]),
 *       tools: new NamedTools({ tags: ['calendar'] }),
 *     }),
 *   ],
 * });
 *
 * const result = await agents.run('assistant', { input: 'what is on today?' });
 * ```
 *
 * `LlmReasoner` is written against `@hermes/model`'s interfaces and has no
 * provider. It is finished, not deferred: the day an Ollama or Claude provider
 * ships, it is constructed with one and works.
 *
 * See `docs/rfcs/RFC-0005-agent-framework.md` for why it is shaped this way.
 */

export { AgentRuntime } from './runtime.js';
export type { AgentRegistry, AgentRuntimeOptions } from './runtime.js';

export { AgentSession, failedObservation } from './session.js';
export type { AgentSessionOptions, RunOptions } from './session.js';

export { capabilityOf, defineAgent } from './agent.js';
export type { Agent } from './agent.js';

export type { AgentContext } from './context.js';

export type {
  AbstainDecision,
  AgentCapability,
  AgentDecision,
  AgentRequest,
  AgentResult,
  AnswerDecision,
  DelegateDecision,
  PlanDecision,
  SessionId,
  SessionOutcome,
  SessionTurn,
  ToolObservation,
  ToolRequest,
  ToolsDecision,
  Transcript,
} from './model.js';
export { toSessionId } from './model.js';

export type { Reasoner } from './ports/reasoner.js';
export type { AgentExecutor, AvailableCapability } from './ports/agent-executor.js';
export type { MemoryAdapter, RecallLimits } from './ports/memory-adapter.js';
export type { PlannerAdapter } from './ports/planner-adapter.js';
export type { ToolSelectionStrategy } from './ports/tool-selection.js';

export { matches, RuleBasedReasoner } from './reasoners/rule-based.js';
export type {
  Rule,
  RuleBasedReasonerOptions,
  RuleMatcher,
} from './reasoners/rule-based.js';
export { ReasonerChain } from './reasoners/reasoner-chain.js';
export type { ReasonerChainOptions } from './reasoners/reasoner-chain.js';
export { LlmReasoner, renderTranscript } from './reasoners/llm-reasoner.js';
export type { LlmReasonerOptions } from './reasoners/llm-reasoner.js';

export { AllTools, NamedTools, NoTools } from './tool-selection.js';
export type { NamedToolsOptions } from './tool-selection.js';

export { withMiddleware } from './middleware.js';
export type { AgentMiddleware, NextDecision } from './middleware.js';

export { memoryAdapter } from './adapters/memory-adapter.js';
export { asKernelAgent, kernelExecutor } from './adapters/kernel-agent.js';
export type { KernelAgentOptions } from './adapters/kernel-agent.js';

export {
  AgentError,
  AgentNotFoundError,
  DelegationLoopError,
  InvalidInputError,
  ReasoningFailedError,
  toError,
  TurnsExhaustedError,
} from './errors.js';
export type { AgentErrorCode, ReasonerAttempt } from './errors.js';
