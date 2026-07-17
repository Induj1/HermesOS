/**
 * AgentRuntime — the composition root and the public entry point.
 *
 * Everything below it is independently usable: a `Reasoner` works without an
 * agent, `AgentSession` without a runtime, `RuleBasedReasoner` without any of it.
 * This is the assembled default, so a host writes one call rather than wiring
 * five objects and getting the clock wrong in one of them — the same role
 * `PlannerService` plays for the planner (RFC-0003 §5.2).
 *
 * ## It is not a kernel Runtime, and does not want to be
 *
 * The name is deliberate and so is the distance: this has no `start`, no `stop`,
 * no lifecycle, no scheduler, no concurrency budget. It registers agents and
 * opens sessions. A reader who expects `Runtime.create().start()` should read
 * that absence as the point — a thing that could be started would be a thing that
 * runs work, and this decides.
 *
 * ## Why the registry is the kernel's
 *
 * `AgentRegistry` is `Registry<Agent>` from `@hermes/kernel` — reused, not
 * reimplemented. It already has the one property that matters: registering a
 * duplicate name throws rather than silently replacing, because "two plugins that
 * both define a 'search' tool is a conflict the host must resolve explicitly, not
 * a race decided by plugin load order" (kernel `registry.ts`). That argument is
 * exactly as true for agents, and writing a second class to make it again would
 * be a class whose only distinction is the word in its error messages.
 */

import { noopLogger, randomIds, Registry, systemClock } from '@hermes/kernel';
import type { Clock, IdGenerator, Logger, ReadonlyRegistry } from '@hermes/kernel';
import type { Agent } from './agent.js';
import { InvalidInputError } from './errors.js';
import type { AgentCapability, AgentRequest, AgentResult } from './model.js';
import type { AgentExecutor } from './ports/agent-executor.js';
import type { MemoryAdapter } from './ports/memory-adapter.js';
import type { PlannerAdapter } from './ports/planner-adapter.js';
import { AgentSession, type RunOptions } from './session.js';

/**
 * A name → agent map with a no-clobber rule.
 *
 * An alias, not a subclass. The kernel's `Registry` is already exactly this, and
 * the alias exists so a reader of `@hermes/agent` sees the concept named in their
 * own vocabulary without a second implementation of it existing.
 */
export type AgentRegistry = Registry<Agent>;

export interface AgentRuntimeOptions {
  /**
   * How tool requests get run, by default.
   *
   * **Optional, because an executor is really a property of *where a session
   * runs*, not of the runtime.** A session driven from a REST handler wants one
   * backed by `@hermes/execution`; the same agent reached through
   * `asKernelAgent` must use *that kernel task's* `ToolAccess`, so its tools are
   * dispatched by the kernel, counted against its concurrency, and cancelled
   * with it. One runtime legitimately serves both, so the executor is an
   * argument to {@link AgentRuntime.session} and this is only the fallback.
   *
   * A runtime with neither still works for agents that only ever answer.
   * {@link AgentRuntime.session} throws if a session is opened with no executor
   * from either source — at session creation, naming the gap, rather than at the
   * first tool request with a message about `undefined`.
   */
  readonly executor?: AgentExecutor;
  readonly memory?: MemoryAdapter;
  readonly planner?: PlannerAdapter;
  /** Agents to register at construction. More can be added with {@link register}. */
  readonly agents?: readonly Agent[];
  /** See `AgentSessionOptions.maxTurns`. Default 8. */
  readonly maxTurns?: number;
  readonly throwOnExhausted?: boolean;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
}

export class AgentRuntime {
  readonly #agents: AgentRegistry = new Registry<Agent>('agent');
  readonly #options: AgentRuntimeOptions;

  constructor(options: AgentRuntimeOptions) {
    this.#options = options;
    for (const agent of options.agents ?? []) this.register(agent);
  }

  /** The registry, read-only. For a router listing what it could delegate to. */
  get agents(): ReadonlyRegistry<Agent> {
    return this.#agents;
  }

  /**
   * Add an agent.
   *
   * Registration is open for the life of the runtime, unlike the kernel's
   * plugins, which close at `start()`. The kernel closes its registries because
   * "a running runtime's capabilities are knowable" is a property its scheduler
   * depends on. Nothing here depends on that: a session resolves an agent by name
   * when it needs it, and a delegation that names an agent registered a moment
   * ago is not a race — it either exists at lookup or it does not, and
   * `AgentNotFoundError` says which.
   *
   * @throws {DuplicateRegistrationError} the kernel's, thrown by its registry.
   */
  register(agent: Agent): this {
    if (agent.name.trim() === '') {
      throw new InvalidInputError(['an agent must have a non-empty name']);
    }
    if (agent.description.trim() === '') {
      // Enforced rather than merely typed. `description` is what a router reads
      // to choose this agent and what a model is told when it is offered — an
      // agent that cannot describe itself can only ever be reached by name.
      throw new InvalidInputError([
        `agent "${agent.name}" must have a non-empty description`,
      ]);
    }
    this.#agents.register(agent);
    return this;
  }

  /** What every registered agent says about itself. What a router reads. */
  capabilities(): readonly AgentCapability[] {
    return this.#agents.list().map((agent) => ({
      name: agent.name,
      description: agent.description,
      tags: agent.tags ?? [],
    }));
  }

  /**
   * Ask an agent, and run it to a conclusion.
   *
   * A fresh {@link AgentSession} per call, holding no state between them. Two
   * concurrent calls therefore cannot see each other's turns, which is the whole
   * of this runtime's concurrency story — there is no shared mutable state to
   * protect, so there is nothing to lock. Anything that must persist across
   * requests is a memory, and memories go through `@hermes/memory`.
   */
  async run(
    agent: string,
    request: AgentRequest,
    options: RunOptions = {},
  ): Promise<AgentResult> {
    return await this.session().run(agent, request, options);
  }

  /**
   * A session, for a caller that wants to hold one.
   *
   * Public because "run this agent" is not the only shape: a caller driving
   * several requests through one configuration, or testing a session directly,
   * needs the object rather than the sugar.
   *
   * @param executor Overrides the runtime's default. How `asKernelAgent` gives a
   *   session the tool access of the task it is running inside — see
   *   `adapters/kernel-agent.ts`.
   * @throws {InvalidInputError} when there is no executor from either source.
   *   At session creation rather than at the first tool request, so the message
   *   can name the gap instead of being a `TypeError` from inside the loop.
   */
  session(executor?: AgentExecutor): AgentSession {
    const resolved = executor ?? this.#options.executor;
    if (!resolved) {
      throw new InvalidInputError([
        'this session has no executor: pass one to session(), or give the runtime a default. ' +
          'Without one an agent can answer but can never ask for a tool',
      ]);
    }

    return new AgentSession({
      agents: this.#agents,
      executor: resolved,
      ...(this.#options.memory === undefined ? {} : { memory: this.#options.memory }),
      ...(this.#options.planner === undefined
        ? {}
        : { planner: this.#options.planner }),
      ...(this.#options.maxTurns === undefined
        ? {}
        : { maxTurns: this.#options.maxTurns }),
      ...(this.#options.throwOnExhausted === undefined
        ? {}
        : { throwOnExhausted: this.#options.throwOnExhausted }),
      clock: this.#options.clock ?? systemClock,
      logger: this.#options.logger ?? noopLogger,
      ids: this.#options.ids ?? randomIds,
    });
  }
}
