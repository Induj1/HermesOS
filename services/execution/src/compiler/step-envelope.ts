/**
 * The step envelope — the engine's one agent, and how data flows.
 *
 * ## The trick, stated plainly
 *
 * A plan step naming `tool:calendar.today` does **not** compile to a task naming
 * `tool:calendar.today`. It compiles to a task naming `agent:hermes.step`, whose
 * *input* says which capability to run and what to pass it. At dispatch, this
 * agent resolves the step's `$from` references against the execution context —
 * which by then holds the results of everything upstream — and invokes the real
 * capability.
 *
 * That indirection is the entire mechanism behind step data flow, and it is what
 * RFC-0001 §11.4 describes:
 *
 * > the least-bad shape is probably an explicit, kernel-opaque reference —
 * > `input: { $from: 'a' }` resolved by the runtime at dispatch
 *
 * with one change: **resolved by the engine at dispatch, not by the runtime.**
 * The kernel is frozen, and it must not learn what a payload means. It doesn't:
 * from where it sits, it dispatched an agent with some input and got a value
 * back, exactly as it does for every other agent. Every guarantee it makes still
 * holds — ordering by `dependsOn`, the global concurrency cap, retry with
 * backoff, timeouts, cancellation, the failure policy, and the events memory
 * persists. The engine did not reimplement one of them.
 *
 * ## What this costs, honestly
 *
 * The kernel's view of the mission says every task is `agent:hermes.step`. So
 * `mission_task.handler` in `@hermes/memory`'s projection is the envelope's name
 * rather than the real capability, for every task. This is the price of the
 * design and it is paid in the audit log.
 *
 * It is mitigated, not ignored: the real capability is written into task
 * metadata at compile time (`compilePlan`), which the kernel carries untouched
 * and memory persists, so nothing is actually lost — it moved one column over.
 * And the engine's own history (`ExecutionSnapshot.steps`) names real
 * capabilities directly, because it never went through the kernel. See RFC-0004
 * §7.1 for why the alternative — real handlers, no data flow — was worse.
 */

import type { AgentContext, Agent, AnyAgent, ReadonlyRegistry } from '@hermes/kernel';
import { defineAgent } from '@hermes/kernel';
import type { CapabilityRef } from '@hermes/planner';
import { InvalidInputError } from '../errors.js';
import { resolveRefs } from '../refs.js';
import type { ResultLookup } from '../refs.js';

/** The name the envelope registers under. One agent, for every step of every plan. */
export const STEP_AGENT_NAME = 'hermes.step';

/**
 * What the engine puts in a compiled task's `input`.
 *
 * Plain data — it goes through the kernel, which serialises nothing but also
 * promises nothing, and through `@hermes/memory`'s audit log, which does
 * serialise it. A closure here would be invisible until the first time someone
 * read the log.
 */
export interface StepEnvelope {
  /**
   * Which execution this task belongs to.
   *
   * Carried in the payload rather than captured in a closure because the kernel
   * only accepts plugins before `start()` (`runtime.ts` `use`), so there is
   * exactly **one** envelope agent for the whole process — registered once, at
   * setup, by the host. It therefore cannot close over an execution that did not
   * exist yet, and must be told which one it is serving on every dispatch.
   *
   * That constraint turns out to be a feature. Two executions running
   * concurrently on one runtime share this agent, and an envelope that resolved
   * one execution's references against another's results would be the worst bug
   * this package could have. Keying on an id that travels *with the task* makes
   * that mistake unrepresentable rather than merely unlikely.
   */
  readonly executionId: string;
  /** The plan step this task is. Also the key its result is recorded under. */
  readonly step: string;
  /** What to actually run. */
  readonly capability: CapabilityRef;
  /** The step's input, possibly containing `$from` references. Resolved at dispatch. */
  readonly input?: unknown;
}

/**
 * What the envelope needs from the engine at dispatch.
 *
 * An interface, not the engine, and the direction matters: the envelope is
 * dispatched *by the kernel*, deep inside a scheduler the engine does not
 * control, so it cannot be handed the engine without handing the kernel a way to
 * reach it. This is the narrow surface that keeps that from happening — a
 * lookup, two recorders, and nothing that can start work.
 */
export interface StepSink {
  /** Where `$from` reads from. */
  readonly results: ResultLookup;
  /** The agents registry, for a step whose capability is an agent. See below. */
  readonly agents: ReadonlyRegistry<AnyAgent>;
  /** Called before the capability runs, with references already resolved. */
  onStepStart(step: string, attempt: number, input: unknown): void;
  /** Called with whatever the capability returned. This is what `$from` will read. */
  onStepSuccess(step: string, result: unknown): Promise<void>;
  /** Called with whatever it threw. The kernel decides whether to retry. */
  onStepFailure(step: string, thrown: unknown): void;
}

/**
 * Find the execution a dispatched envelope belongs to.
 *
 * A function rather than a `Map`, and rather than the engine itself. The engine
 * cannot be passed here: this agent is invoked by the kernel, from inside a
 * scheduler the engine does not control, and handing it the engine would hand
 * the kernel a way to start work. A resolver returning a {@link StepSink} is the
 * narrowest thing that answers the question.
 *
 * Returns `undefined` for an execution this process does not know — which is a
 * real case, not a defensive one: a task can outlive its execution if the engine
 * gave up while a step was in flight.
 */
export type SinkResolver = (executionId: string) => StepSink | undefined;

/**
 * Build the one envelope agent.
 *
 * Registered once per runtime, by the host, before `start()` — see
 * {@link StepEnvelope.executionId} for why it cannot be per-execution.
 */
export function stepEnvelope(
  resolve: SinkResolver,
  name = STEP_AGENT_NAME,
): Agent<StepEnvelope> {
  return defineAgent<StepEnvelope, unknown>({
    name,
    description:
      'Runs one plan step: resolves its $from references against the execution context, ' +
      'invokes the real capability, and records the result.',
    capabilities: ['hermes.internal'],

    // Parsed, not cast. This input crossed the kernel, and on a resume it came
    // out of a checkpoint written by an older version of this package. Both are
    // boundaries, and a boundary that trusts its input is not a boundary.
    input: {
      parse: (input: unknown): StepEnvelope => {
        if (input === null || typeof input !== 'object') {
          throw new InvalidInputError(['step envelope must be an object']);
        }
        const raw = input as Record<string, unknown>;
        const issues: string[] = [];

        if (
          typeof raw['executionId'] !== 'string' ||
          raw['executionId'].trim() === ''
        ) {
          issues.push('envelope.executionId must be a non-empty string');
        }
        if (typeof raw['step'] !== 'string' || raw['step'].trim() === '') {
          issues.push('envelope.step must be a non-empty string');
        }
        const raw_capability = raw['capability'];
        if (raw_capability === null || typeof raw_capability !== 'object') {
          issues.push('envelope.capability must be an object');
        } else {
          const capability = raw_capability as Record<string, unknown>;
          if (capability['kind'] !== 'tool' && capability['kind'] !== 'agent') {
            issues.push('envelope.capability.kind must be "tool" or "agent"');
          }
          if (
            typeof capability['name'] !== 'string' ||
            capability['name'].trim() === ''
          ) {
            issues.push('envelope.capability.name must be a non-empty string');
          }
        }
        if (issues.length > 0) throw new InvalidInputError(issues);

        return {
          executionId: raw['executionId'] as string,
          step: raw['step'] as string,
          capability: raw['capability'] as CapabilityRef,
          ...('input' in raw ? { input: raw['input'] } : {}),
        };
      },
    },

    handle: async (envelope: StepEnvelope, ctx: AgentContext): Promise<unknown> => {
      const sink = resolve(envelope.executionId);
      if (!sink) {
        // The engine has forgotten this execution while one of its tasks was
        // still in flight — it gave up, or the process that owned it died and
        // this runtime outlived it. Failing the task is the honest outcome:
        // running the capability would have an effect nobody is waiting for and
        // nowhere to record it.
        throw new InvalidInputError([
          `execution "${envelope.executionId}" is not running here, so step ` +
            `"${envelope.step}" has nowhere to record its result`,
        ]);
      }

      // Resolved here, at dispatch, and never earlier. On a retry this runs
      // again — which is correct and load-bearing: a reference resolves against
      // whatever the context holds *now*, so a step retried after its dependency
      // was itself retried reads the newer value rather than a stale capture.
      const input = resolveRefs(envelope.input, sink.results);

      sink.onStepStart(envelope.step, ctx.attempt, input);

      let result: unknown;
      try {
        result = await invoke(envelope.capability, input, ctx, sink);
      } catch (thrown) {
        sink.onStepFailure(envelope.step, thrown);
        // Rethrown, always. The kernel owns retry, the failure policy, and
        // whether the mission lives — and it decides all three from whether this
        // throws. Swallowing here to "handle" the error would tell the kernel the
        // step succeeded, and the mission would sail on with a step that did not
        // happen. The engine records; the kernel decides.
        throw thrown;
      }

      await sink.onStepSuccess(envelope.step, result);
      return result;
    },
  });
}

/**
 * Invoke the real capability.
 *
 * A tool goes through `ctx.tools`, which is the kernel's own path — its
 * validator, its error wrapping, its logging. Nothing is reimplemented.
 *
 * An agent cannot: `AgentContext` exposes `tools`, not agents, so the kernel
 * offers no way for one agent to invoke another (`runtime.ts` `#toolAccess`).
 * That is a deliberate kernel decision and not one to work around lightly, so
 * this does the minimum: it looks the agent up in the *public* `runtime.agents`
 * registry and calls it, passing its own context through — which is what gives
 * the inner agent the same tools, signal, clock, and logger the kernel would
 * have given it.
 *
 * The one thing that must not be skipped is the agent's own `input` validator,
 * because the kernel applies it (`runtime.ts` `#execute`) and an agent that
 * declared one is entitled to it. So it is applied here too. That is the only
 * line of kernel dispatch this duplicates, and it is duplicated on purpose
 * rather than dropped.
 */
async function invoke(
  capability: CapabilityRef,
  input: unknown,
  ctx: AgentContext,
  sink: StepSink,
): Promise<unknown> {
  if (capability.kind === 'tool') {
    return await ctx.tools.invoke(capability.name, input);
  }

  const agent = sink.agents.get(capability.name);
  if (!agent) {
    // The same error the kernel would have raised at dispatch, in the same shape,
    // so a caller branching on it cannot tell the envelope was involved. In
    // practice unreachable: the planner validated this capability against the
    // catalog before the plan was accepted (RFC-0003 §4). It fires only if a
    // plugin was unregistered between planning and dispatch.
    throw new InvalidInputError([`No agent named "${capability.name}" is registered`]);
  }

  const parsed = agent.input ? agent.input.parse(input) : input;
  return await agent.handle(parsed, ctx);
}
