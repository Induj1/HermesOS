/**
 * AgentSession — one request, run to a conclusion.
 *
 * ## The loop, and why owning it is not owning execution
 *
 * ```
 * decide ──▶ tools? ──yes──▶ executor.execute() ──▶ observations ──┐
 *   ▲                                                              │
 *   └──────────────────────────────────────────────────────────────┘
 *   │
 *   └── answer / plan / abstain ──▶ done
 * ```
 *
 * The session drives the think-act-observe cycle, and that is reasoning: deciding
 * *whether there is another turn* is a judgement about the conversation, which is
 * this subsystem's business. The **acting** is delegated to `AgentExecutor`, an
 * interface this package declares and never implements. The session cannot tell
 * whether anything ran, only what came back.
 *
 * That line is worth defending explicitly, because it is the one a future change
 * will blur. A session that reached for a `Runtime` to "just run this quickly"
 * would have moved execution into the reasoning layer, and the only thing
 * stopping it is that there is nothing here to reach for.
 *
 * ## Why a session at all, rather than `agent.reason()`
 *
 * Because one decision is rarely an answer. A model asks for a tool, reads the
 * result, and asks for another. Everything that is genuinely hard lives in that
 * loop and nowhere else: the turn budget, the transcript, delegation, loop
 * detection, and what to do when a tool fails. A caller doing it by hand would
 * write all five, and get the fifth wrong.
 */

import { noopLogger, randomIds, systemClock } from '@hermes/kernel';
import type { Clock, IdGenerator, Logger, ReadonlyRegistry } from '@hermes/kernel';
import { totalUsage } from '@hermes/model';
import type { TokenUsage } from '@hermes/model';
import type { Agent } from './agent.js';
import type { AgentContext } from './context.js';
import {
  AgentNotFoundError,
  DelegationLoopError,
  TurnsExhaustedError,
  toError,
} from './errors.js';
import type {
  AgentDecision,
  AgentRequest,
  AgentResult,
  SessionId,
  SessionOutcome,
  SessionTurn,
  ToolObservation,
} from './model.js';
import { toSessionId } from './model.js';
import type { AgentExecutor, AvailableCapability } from './ports/agent-executor.js';
import type { MemoryAdapter } from './ports/memory-adapter.js';
import type { PlannerAdapter } from './ports/planner-adapter.js';
import { renderTranscript } from './reasoners/llm-reasoner.js';
import { AllTools } from './tool-selection.js';

export interface AgentSessionOptions {
  readonly agents: ReadonlyRegistry<Agent>;
  readonly executor: AgentExecutor;
  readonly memory?: MemoryAdapter;
  readonly planner?: PlannerAdapter;
  /**
   * How many decisions before giving up. Default 8.
   *
   * A bound, not a target. A model that asks for a tool, reads it, and asks for
   * the same tool again will do that forever, and each turn is a model call
   * somebody pays for. 8 is enough for a genuinely multi-step task and small
   * enough that a loop costs pennies rather than a bill — and when it trips, the
   * transcript says which two turns repeated.
   */
  readonly maxTurns?: number;
  /**
   * Throw `TurnsExhaustedError` instead of returning `outcome: 'exhausted'`.
   *
   * Default false. An agent looping is a *finding*, and the transcript is the
   * evidence — throwing it away to raise an exception discards exactly what the
   * operator needs. A host that would rather have the exception asks for it.
   */
  readonly throwOnExhausted?: boolean;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly sessionId?: SessionId;
}

export class AgentSession {
  readonly #agents: ReadonlyRegistry<Agent>;
  readonly #executor: AgentExecutor;
  readonly #memory: MemoryAdapter | undefined;
  readonly #planner: PlannerAdapter | undefined;
  readonly #maxTurns: number;
  readonly #throwOnExhausted: boolean;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #ids: IdGenerator;

  constructor(options: AgentSessionOptions) {
    this.#agents = options.agents;
    this.#executor = options.executor;
    this.#memory = options.memory;
    this.#planner = options.planner;
    this.#maxTurns = options.maxTurns ?? 8;
    this.#throwOnExhausted = options.throwOnExhausted ?? false;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.#ids = options.ids ?? randomIds;
  }

  /**
   * Run an agent until it answers, abstains, asks for a plan, or runs out.
   *
   * Resolves with a result in every one of those cases, including failure —
   * deliberately unlike `ExecutionEngine.execute`, which throws (RFC-0004 §5).
   * The difference is real: an execution that failed did not achieve its goal,
   * while an agent that abstained *behaved correctly and said so*. Making a
   * caller `catch` an abstention would put a normal outcome on the exception path
   * and, worse, discard the transcript that explains it.
   *
   * @throws {AgentNotFoundError} a delegation named an agent nobody registered.
   * @throws {DelegationLoopError} agents delegated in a circle.
   * @throws {TurnsExhaustedError} only when `throwOnExhausted` was asked for.
   */
  async run(
    agentName: string,
    request: AgentRequest,
    options: RunOptions = {},
  ): Promise<AgentResult> {
    const sessionId = options.sessionId ?? toSessionId(this.#ids('session'));
    const startedAt = this.#clock.now();
    const turns: SessionTurn[] = [];
    const usages: (TokenUsage | undefined)[] = [];

    let agent = this.#require(agentName);
    let current = request;
    // Every agent this session has asked, in order. Both the loop detector and
    // the error's message, which is the only thing that identifies the misconfigured
    // pair.
    const path: string[] = [agent.name];

    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      options.signal?.throwIfAborted();

      const ctx = this.#context(sessionId, turn, agent, current, turns, options.signal);
      const decision = await agent.reasoner.reason(current, ctx);
      usages.push(usageOf(decision));

      if (decision.kind === 'tools') {
        // The one place work leaves this package. It goes out through an
        // interface, to an implementation the framework has never seen.
        const observations = await this.#executor.execute(
          decision.requests,
          options.signal,
        );
        turns.push({
          turn,
          agent: agent.name,
          decision,
          observations,
          at: this.#clock.now(),
        });

        this.#logger.debug('Tools ran', {
          session: sessionId,
          agent: agent.name,
          requested: decision.requests.length,
          failed: observations.filter((observation) => !observation.ok).length,
        });
        // Round again. The observations are in `history`, so the next decision
        // sees them — a reasoner is stateless between turns and that is its
        // memory of the last one.
        continue;
      }

      turns.push({ turn, agent: agent.name, decision, at: this.#clock.now() });

      if (decision.kind === 'delegate') {
        agent = this.#delegate(decision.agent, path);
        current = decision.request ?? current;
        continue;
      }

      // answer | plan | abstain — all terminal, and all a real conclusion.
      return this.#result(
        sessionId,
        outcomeOf(decision),
        decision,
        turns,
        usages,
        startedAt,
      );
    }

    this.#logger.warn('Agent did not reach an answer within its turn budget', {
      session: sessionId,
      agent: agent.name,
      turns: this.#maxTurns,
    });
    if (this.#throwOnExhausted)
      throw new TurnsExhaustedError(agent.name, this.#maxTurns);

    return this.#result(
      sessionId,
      'exhausted',
      // The last decision was necessarily a `tools` one — anything else would
      // have returned. Reporting *that* as the outcome would claim the agent
      // decided something final when it was mid-thought, so the result says what
      // is true: it never concluded.
      {
        kind: 'abstain',
        reason: `Did not conclude within ${String(this.#maxTurns)} turns`,
      },
      turns,
      usages,
      startedAt,
    );
  }

  #require(name: string): Agent {
    const agent = this.#agents.get(name);
    if (!agent) {
      throw new AgentNotFoundError(
        name,
        this.#agents.list().map((candidate) => candidate.name),
      );
    }
    return agent;
  }

  /**
   * Hand off to another agent, refusing a circle.
   *
   * The check is "have we asked this agent before", not "is this the agent we
   * just asked". A → B → A is the common misconfiguration and the narrow check
   * would miss it; A → B → C → A is rarer and just as fatal. Neither is worth
   * distinguishing, and the path names both.
   */
  #delegate(name: string, path: string[]): Agent {
    if (path.includes(name)) throw new DelegationLoopError([...path, name]);

    const agent = this.#require(name);
    path.push(name);
    this.#logger.debug('Delegated', { to: name, path });
    return agent;
  }

  #context(
    sessionId: SessionId,
    turn: number,
    agent: Agent,
    request: AgentRequest,
    history: readonly SessionTurn[],
    signal: AbortSignal | undefined,
  ): AgentContext {
    const selector = agent.tools ?? new AllTools();
    const capabilities: readonly AvailableCapability[] = selector.select(
      request,
      this.#executor.available(),
    );

    return {
      sessionId,
      turn,
      // Already selected. A reasoner sees what it is meant to see and has no way
      // to widen its own reach — the executor, which knows about everything, is
      // never handed over.
      capabilities,
      history,
      // Built once per turn, by the session, so a chain of reasoners agrees on
      // what was said rather than each rebuilding it and disagreeing.
      transcript: renderTranscript(request, history, (input) =>
        typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
      ),
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      ...(this.#planner === undefined ? {} : { planner: this.#planner }),
      clock: this.#clock,
      logger: this.#logger.child({ session: sessionId, agent: agent.name }),
      signal,
    };
  }

  #result(
    sessionId: SessionId,
    outcome: SessionOutcome,
    decision: AgentDecision,
    turns: readonly SessionTurn[],
    usages: readonly (TokenUsage | undefined)[],
    startedAt: number,
  ): AgentResult {
    const usage = totalUsage(usages);
    return {
      sessionId,
      outcome,
      decision,
      turns,
      // Absent when nothing reported any: "this cost nothing" and "nobody said
      // what this cost" are different facts, and a deterministic session
      // legitimately reports neither.
      ...(usage === undefined ? {} : { usage }),
      startedAt,
      finishedAt: this.#clock.now(),
    };
  }
}

function outcomeOf(decision: AgentDecision): SessionOutcome {
  if (decision.kind === 'answer') return 'answered';
  if (decision.kind === 'plan') return 'planned';
  return 'abstained';
}

function usageOf(decision: AgentDecision): TokenUsage | undefined {
  return 'usage' in decision ? decision.usage : undefined;
}

/**
 * Build an observation for a tool that could not be run.
 *
 * Exported for hosts writing an `AgentExecutor`: the port says a failing tool is
 * an `ok: false` observation rather than a rejection, and this is the shape of
 * one. Offering it here means every executor reports failures the same way,
 * rather than each inventing a message format the transcript then renders
 * inconsistently.
 */
export function failedObservation(
  request: { id: string; name: string },
  thrown: unknown,
): ToolObservation {
  const error = toError(thrown);
  const code = (error as { code?: unknown }).code;
  return {
    id: request.id,
    name: request.name,
    ok: false,
    error: {
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    },
  };
}
