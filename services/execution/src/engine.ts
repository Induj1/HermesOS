/**
 * ExecutionEngine — the orchestration layer above the kernel.
 *
 * ## What it is
 *
 * The kernel runs one mission and refuses to know what the tasks mean. The
 * planner produces a plan and refuses to run it. This runs the plan: it wraps
 * each step so data can flow between them, submits the mission, records what
 * happened, checkpoints after every step, and — if asked — replans around a
 * failure and submits the successor mission.
 *
 * ```
 * Plan ──▶ compile (envelopes) ──▶ Runtime.run ──▶ settled?
 *   ▲                                                 │
 *   └──────── replan (unfinished part) ◀──── failed ──┤
 *                                                     └── succeeded ──▶ ExecutionSnapshot
 * ```
 *
 * ## What it deliberately does not do
 *
 * **It does not schedule.** No readiness calculation, no concurrency accounting,
 * no retry loop, no backoff, no timeout. Every one of those is the kernel's, and
 * this engine reaches them by handing the kernel a mission whose `dependsOn`
 * still means what it always meant. The temptation to run steps itself — a
 * `topoSort` and a `Promise.all` — is the single worst change anyone could make
 * to this file: it would fork the scheduler, and the fork would be the one
 * without 161 tests behind it.
 *
 * **It does not plan.** `Replanner` decides what a recovery mission contains.
 * This decides only *whether* to ask for one.
 *
 * **It does not persist history.** `@hermes/memory` already persists every
 * kernel event through the seam RFC-0001 §11.2 reserved. A host that wires
 * `memoryPlugin` into its runtime gets this engine's missions in the audit log
 * for free, and `mission:submitted` is the key that ties them to an execution.
 * Writing a second history here would be two accounts of the same events.
 */

import {
  definePlugin,
  EventBus,
  noopLogger,
  randomIds,
  systemClock,
  type Clock,
  type IdGenerator,
  type Logger,
  type MissionId,
  type MissionSnapshot,
  type Plugin,
  type Runtime,
} from '@hermes/kernel';
import type { Plan } from '@hermes/planner';
import { Replanner, type PlanContext } from '@hermes/planner';
import { compileExecution } from './compiler/execution-compiler.js';
import { stepEnvelope, type StepSink } from './compiler/step-envelope.js';
import { ExecutionContext } from './context/execution-context.js';
import {
  ExecutionFailedError,
  ExecutionNotFoundError,
  ExecutionStateError,
  InvalidInputError,
  RecoveryExhaustedError,
  toStepError,
} from './errors.js';
import type { ExecutionEventMap } from './events.js';
import {
  TERMINAL_EXECUTION_STATES,
  toExecutionId,
  type ExecutionCheckpoint,
  type ExecutionId,
  type ExecutionSnapshot,
  type ExecutionState,
  type StepRecord,
} from './model.js';
import type { CheckpointStore } from './ports/checkpoint-store.js';
import { InMemoryCheckpointStore } from './ports/in-memory-checkpoint-store.js';
import {
  NO_RECOVERY,
  shouldRecover,
  type RecoveryPolicy,
} from './recovery/recovery-policy.js';

export interface ExecutionEngineOptions {
  /**
   * The runtime missions are submitted to. Must be started before `execute`.
   *
   * Held rather than created: a runtime is the *host's* composition root — it
   * owns the plugins, the capabilities, and the concurrency budget for
   * everything, not just for this engine. An engine that made its own would
   * either duplicate the host's plugins or run steps against an empty registry.
   */
  readonly runtime: Runtime;
  readonly checkpoints?: CheckpointStore;
  readonly recovery?: RecoveryPolicy;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
}

export interface ExecuteOptions {
  /** Cancels the execution. Honoured between missions and by every running step. */
  readonly signal?: AbortSignal;
  /** Resume an existing execution id rather than minting one. Used by `resume`. */
  readonly executionId?: ExecutionId;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class ExecutionEngine {
  /** Where execution events are published. The engine's own bus, never the kernel's. */
  readonly events = new EventBus<ExecutionEventMap>();

  readonly #runtime: Runtime;
  readonly #checkpoints: CheckpointStore;
  readonly #recovery: RecoveryPolicy;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #ids: IdGenerator;

  /** Executions running in this process, so `pause` has something to act on. */
  readonly #live = new Map<ExecutionId, LiveExecution>();

  constructor(options: ExecutionEngineOptions) {
    this.#runtime = options.runtime;
    this.#checkpoints = options.checkpoints ?? new InMemoryCheckpointStore();
    this.#recovery = options.recovery ?? NO_RECOVERY;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.#ids = options.ids ?? randomIds;
  }

  /** The store checkpoints are written to. For a supervisor scanning `pending()`. */
  get checkpoints(): CheckpointStore {
    return this.#checkpoints;
  }

  /**
   * Run a plan to settlement.
   *
   * Resolves with a snapshot for a plan that succeeded, and **throws** for one
   * that did not. The asymmetry is deliberate: a caller that forgets to check
   * `snapshot.state` would treat a total failure as success, and the whole point
   * of a promise is that the unhappy path is the one you cannot forget. The
   * snapshot is on the error too, for a caller that wants it.
   *
   * @throws {ExecutionFailedError} the plan did not achieve its goal.
   * @throws {RecoveryExhaustedError} recovery was enabled and did not converge.
   */
  async execute(plan: Plan, options: ExecuteOptions = {}): Promise<ExecutionSnapshot> {
    const live = await this.#begin(plan, options);
    return await this.#drive(live, options);
  }

  /**
   * Pause a running execution.
   *
   * ## Pause is cancel-and-checkpoint, and it has to be
   *
   * The kernel has no pause, and this does not add one. A mission runs to
   * settlement or is cancelled; there is no third state and no way back from the
   * second (RFC-0001 §11.3). The alternative — the envelope blocking at dispatch
   * until un-paused — was rejected and is worth saying why: a blocked envelope
   * **holds its concurrency slot**. Pause a plan wider than the concurrency
   * budget and the runtime deadlocks with every slot held by a step waiting for
   * a resume that needs a slot to happen. RFC-0001 §11.3 names that same trap
   * for sub-missions.
   *
   * So: the mission is cancelled, the checkpoint is authoritative, and `resume`
   * submits a *new* mission for the unfinished part. Steps that had already
   * succeeded are not re-run; their results are in the context and still resolve.
   * Steps that were mid-flight are cancelled, and what that means for their
   * effects is the same at-least-once conversation RFC-0001 §11.2 has — which is
   * why resume takes an `incomplete` policy rather than guessing.
   *
   * @throws {ExecutionStateError} if the execution is not running here.
   */
  async pause(id: ExecutionId): Promise<ExecutionSnapshot> {
    const live = this.#live.get(id);
    if (!live) throw new ExecutionNotFoundError(id);
    if (live.state !== 'running') {
      throw new ExecutionStateError(id, live.state, 'pause');
    }

    live.state = 'paused';
    live.paused = true;
    await this.#runtime.cancelMission(live.mission());

    const snapshot = this.#snapshot(live);
    await this.#checkpoint(live);
    await this.events.emit('execution:paused', { execution: snapshot });
    return snapshot;
  }

  /**
   * Pick up an execution from its checkpoint.
   *
   * Works for one this process paused and for one a *dead* process left behind —
   * the checkpoint is the only input, which is the whole reason it carries the
   * plan whole rather than by id. That is what makes crash recovery and pause
   * the same code path rather than two.
   *
   * @throws {ExecutionNotFoundError} no checkpoint with this id.
   * @throws {ExecutionStateError} the execution already settled.
   */
  async resume(
    id: ExecutionId,
    options: ExecuteOptions = {},
  ): Promise<ExecutionSnapshot> {
    const checkpoint = await this.#checkpoints.load(id);
    if (!checkpoint) throw new ExecutionNotFoundError(id);
    if (TERMINAL_EXECUTION_STATES.includes(checkpoint.state)) {
      throw new ExecutionStateError(id, checkpoint.state, 'resume');
    }

    const live = this.#reviveFrom(checkpoint);
    this.#live.set(id, live);

    await this.events.emit('execution:resumed', { execution: this.#snapshot(live) });
    return await this.#drive(live, options);
  }

  /** The stored view of an execution, running or not. */
  async snapshot(id: ExecutionId): Promise<ExecutionSnapshot | undefined> {
    const live = this.#live.get(id);
    if (live) return this.#snapshot(live);

    const checkpoint = await this.#checkpoints.load(id);
    return checkpoint ? snapshotOf(checkpoint) : undefined;
  }

  // ---------------------------------------------------------------------------

  /** Mint an execution, seed its context, and write the first checkpoint. */
  async #begin(plan: Plan, options: ExecuteOptions): Promise<LiveExecution> {
    if (plan.steps.length === 0) {
      // The kernel would reject the compiled mission ("at least one task"), but
      // it would name a mission the caller never built. Rejected here, where the
      // message can name the plan.
      throw new InvalidInputError(['a plan must have at least one step to execute']);
    }

    const id = options.executionId ?? toExecutionId(this.#ids('exec'));
    const context = new ExecutionContext(this.#clock);
    context.declare(plan.steps);

    const live: LiveExecution = {
      id,
      plan,
      context,
      state: 'running',
      missions: [],
      attempts: 0,
      paused: false,
      createdAt: this.#clock.now(),
      metadata: options.metadata ?? {},
      mission: () => {
        const last = live.missions.at(-1);
        /* c8 ignore next -- `mission()` is only called by `pause`, which requires
           state 'running', which is only reachable after a mission is submitted. */
        if (!last) throw new ExecutionStateError(live.id, live.state, 'pause');
        return last;
      },
    };

    this.#live.set(id, live);
    await this.#checkpoint(live);
    await this.events.emit('execution:started', { execution: this.#snapshot(live) });
    return live;
  }

  /** Rebuild in-process state from a checkpoint. The crash-recovery path. */
  #reviveFrom(checkpoint: ExecutionCheckpoint): LiveExecution {
    const context = ExecutionContext.restore(this.#clock, checkpoint.steps);
    const plan = checkpoint.plan;

    const live: LiveExecution = {
      id: checkpoint.id,
      plan,
      context,
      state: 'running',
      missions: [...checkpoint.missions],
      attempts: checkpoint.attempts,
      paused: false,
      createdAt: checkpoint.createdAt,
      metadata: checkpoint.metadata,
      mission: () => {
        const last = live.missions.at(-1);
        /* c8 ignore next */
        if (!last) throw new ExecutionStateError(live.id, live.state, 'pause');
        return last;
      },
    };
    return live;
  }

  /**
   * Run missions until the execution settles.
   *
   * The recovery loop. Each turn submits one mission for whatever is unfinished;
   * a failure either ends it or produces a replan and another turn.
   */
  async #drive(
    live: LiveExecution,
    options: ExecuteOptions,
  ): Promise<ExecutionSnapshot> {
    try {
      for (;;) {
        options.signal?.throwIfAborted();

        // Nothing left to run. Reachable more easily than it looks: cancellation
        // is cooperative (RFC-0001 §11.1), so a step that does not honour its
        // signal keeps going after a pause cancelled its mission and records a
        // real result on the way out. Resuming then finds every step succeeded,
        // and compiling that would hand the kernel a mission with no tasks —
        // which it rightly rejects, with a message about a mission the caller
        // never built.
        //
        // Settling instead is not a workaround, it is the right answer: the work
        // is done, and an execution whose every step succeeded has succeeded.
        if (
          live.context.inState('succeeded').length === live.context.snapshot().length
        ) {
          return await this.#settle(live, 'succeeded');
        }

        const snapshot = await this.#runOnce(live, options);

        if (live.paused) {
          // `pause` cancelled the mission and already wrote the checkpoint and
          // emitted. Returning rather than treating the cancellation as failure
          // is what makes pause a decision instead of an incident.
          return this.#snapshot(live);
        }

        if (snapshot.state === 'succeeded' && live.context.settled) {
          return await this.#settle(live, 'succeeded');
        }

        if (snapshot.state === 'cancelled') {
          // Cancelled is not success, so it throws — the same asymmetry as a
          // failure, and for the same reason: a promise that resolves with a
          // `cancelled` snapshot is one a caller forgets to check. Pause is the
          // deliberate exception, and it returned above.
          //
          // `ExecutionFailedError` with no step failure is not a degenerate
          // case; its message was written for exactly this, because a mission
          // cancelled underneath the engine legitimately settles with nothing
          // recorded against any step.
          await this.#settle(live, 'cancelled');
          throw new ExecutionFailedError(live.id, this.#failures(live));
        }

        const failures = this.#failures(live);
        live.attempts += 1;

        if (
          !shouldRecover(this.#recovery, {
            attempt: live.attempts,
            failures: failures.map(toDecision),
          })
        ) {
          // Not an error yet — `#settle` records `failed`, and the throw below
          // reports it. A recovery budget of 0 (the default) lands here on the
          // first failure, which is why an engine nobody configured behaves
          // exactly like `runtime.run` plus data flow.
          await this.#settle(live, 'failed');
          throw new ExecutionFailedError(live.id, failures);
        }

        await this.#recover(live, failures);
      }
    } catch (thrown) {
      // An abort mid-flight leaves a `running` checkpoint that a supervisor
      // would pick up and resume forever. Recorded as cancelled, then rethrown:
      // the caller asked to stop and is entitled to hear that it stopped.
      if (
        options.signal?.aborted === true &&
        !TERMINAL_EXECUTION_STATES.includes(live.state)
      ) {
        await this.#settle(live, 'cancelled');
      }
      throw thrown;
    } finally {
      this.#live.delete(live.id);
    }
  }

  /**
   * Submit one mission for everything unfinished, and wait for it to settle.
   *
   * ## Why this is not `runtime.run(spec)`
   *
   * `run` is create-submit-await in one call, and it hands back the snapshot
   * only at the end — by which time the mission id is far too late to be useful.
   * `pause` needs that id *while the mission is running*, because pausing is
   * cancelling it (see {@link pause}). `submit` returns the `Mission`
   * synchronously and drops the settlement promise, so the settled snapshot has
   * to be picked up from the bus instead.
   *
   * The listener is attached **before** `submit`, and the ordering is
   * load-bearing rather than stylistic: subscribing afterwards would be a race
   * against a mission that had already settled, and it is the kind of race that
   * passes in a test and hangs in production. Filtering on metadata rather than
   * on the id closes the same hole from the other side — the predicate is
   * complete before the mission that satisfies it exists.
   */
  async #runOnce(
    live: LiveExecution,
    options: ExecuteOptions,
  ): Promise<MissionSnapshot> {
    const done = live.context.inState('succeeded').map((step) => step.name);
    const attempt = live.attempts;

    const spec = compileExecution(live.plan, {
      executionId: live.id,
      exclude: done,
      metadata: { executionId: live.id, attempt },
    });

    const settled = this.#awaitSettlement(live.id, attempt);

    const mission = this.#runtime.submit(spec);
    live.missions.push(mission.id);
    await this.#checkpoint(live);
    await this.events.emit('mission:submitted', {
      executionId: live.id,
      missionId: mission.id,
    });

    // The caller's signal has to reach the kernel, and `submit` takes none — so
    // it is bridged here. Without this, aborting `execute` would stop the engine
    // waiting while the mission carried on running steps for a caller that had
    // already left: the abort would look instant and change nothing.
    const cancelOnAbort = (): void => {
      void this.#runtime.cancelMission(mission.id, 'Execution aborted by caller');
    };
    options.signal?.addEventListener('abort', cancelOnAbort, { once: true });

    try {
      const snapshot = await settled;
      this.#reconcile(live, snapshot);
      await this.#checkpoint(live);
      return snapshot;
    } finally {
      options.signal?.removeEventListener('abort', cancelOnAbort);
    }
  }

  /**
   * Resolve when the mission for this execution attempt reaches a terminal state.
   *
   * Listens for all three settled events at once and unsubscribes from every one
   * on the first — a `Promise.race` over three `waitFor`s would leave two
   * listeners attached to a bus that outlives the execution, which is a leak per
   * mission rather than a one-off.
   */
  #awaitSettlement(id: ExecutionId, attempt: number): Promise<MissionSnapshot> {
    const bus = this.#runtime.bus;
    const mine = (mission: MissionSnapshot): boolean =>
      mission.metadata['executionId'] === id && mission.metadata['attempt'] === attempt;

    return new Promise<MissionSnapshot>((resolve) => {
      const subscriptions: { unsubscribe(): void }[] = [];
      const finish = (mission: MissionSnapshot): void => {
        for (const subscription of subscriptions) subscription.unsubscribe();
        resolve(mission);
      };

      for (const type of [
        'mission:succeeded',
        'mission:failed',
        'mission:cancelled',
      ] as const) {
        subscriptions.push(
          bus.on(type, (payload) => {
            if (mine(payload.mission)) finish(payload.mission);
          }),
        );
      }
    });
  }

  /**
   * The plugin the host must register, before `runtime.start()`.
   *
   * The kernel accepts plugins only in its `created` state (`runtime.ts` `use`),
   * which is not a limitation to route around — it is what makes a runtime's
   * capabilities knowable once it is running. So the engine's envelope is
   * registered once, at setup, like every other capability, and finds its
   * execution per dispatch from the id in the payload.
   */
  plugin(): Plugin {
    return definePlugin({
      name: 'hermes.execution',
      version: '0.0.0',
      setup: (ctx) => {
        ctx.registerAgent(
          stepEnvelope((executionId) => {
            const live = this.#live.get(toExecutionId(executionId));
            return live ? this.#sink(live) : undefined;
          }),
        );
      },
    });
  }

  /**
   * Teach the context what the kernel decided that the envelope could not see.
   *
   * The envelope records a step it *ran*. It never runs for a step the kernel
   * skipped — one whose dependency failed — so without this the context would
   * hold those as `pending` forever, `settled` would never be true, and a resume
   * would try to re-run a step that is not merely unfinished but unreachable.
   * The kernel's snapshot is the only place that fact exists.
   */
  #reconcile(live: LiveExecution, snapshot: MissionSnapshot): void {
    for (const task of snapshot.tasks) {
      const record = live.context.record(task.name);
      if (!record) continue;

      if (task.state === 'skipped' && record.state === 'pending') {
        live.context.skipped(task.name);
        continue;
      }
      // A task the kernel failed for a reason the envelope never saw — a
      // timeout, a cancellation, the runtime stopping — leaves the step
      // `running`. The kernel's error is the only account of it.
      if (task.state === 'failed' && record.state !== 'failed') {
        live.context.failed(
          task.name,
          toStepError(task.error ?? new Error('Task failed')),
        );
      }
      if (task.state === 'cancelled' && record.state === 'running') {
        live.context.failed(
          task.name,
          toStepError(task.error ?? new Error('Task cancelled')),
        );
      }
    }
  }

  /** Replan the unfinished part and go round again. */
  async #recover(live: LiveExecution, failures: readonly Failure[]): Promise<void> {
    live.state = 'recovering';
    const reason = failures
      .map((failure) => `${failure.step}: ${failure.error.message}`)
      .join('; ');

    await this.events.emit('execution:recovering', {
      execution: this.#snapshot(live),
      attempt: live.attempts,
      reason,
    });

    const replanner = new Replanner(this.#planContext());
    let recovered: Plan;
    try {
      // Replanned from the engine's own history rather than the kernel's
      // snapshot — see `#asMissionSnapshot`. Deterministic and model-free, which
      // is what makes recovery work when the thing that failed was the model.
      recovered = replanner.replan(this.#asMissionSnapshot(live), {
        incomplete: this.#recovery.incomplete,
        goal: live.plan.goal,
      });
      /* c8 ignore start -- Not reachable from this engine today, and kept
         deliberately. `Replanner` refuses when nothing is left to carry, which
         needs every remaining step to be abandoned or mid-flight — but
         `#reconcile` has already resolved every step the kernel settled into a
         terminal state, and the replanner treats `failed` as outstanding work
         (RFC-0003 §7.2). So the refusal cannot fire while those two agree.
         It is a guard, not dead code: without it a `NothingToReplanError` — a
         *planner* error — would reach a caller of the *engine*, which is exactly
         the cross-layer leak `errors.ts` exists to prevent. If the reconciler or
         the replanner's `RESUMABLE` set ever changes, this is what stops that
         leak from being the way anyone finds out. See RFC-0004 §7.4. */
    } catch (thrown) {
      await this.#settle(live, 'failed');
      throw new RecoveryExhaustedError(
        live.id,
        live.attempts,
        (thrown as Error).message,
      );
    }
    /* c8 ignore stop */

    // The recovered plan's steps replace the unfinished ones. Steps that already
    // succeeded are not in it and are not touched — their results stay in the
    // context, and a surviving `$from` still resolves to them.
    live.plan = mergePlan(live.plan, recovered);
    for (const step of recovered.steps) {
      live.context.reset(step.name);
    }
    live.state = 'running';
  }

  /** What the `Replanner` needs, projected from what the engine knows. */
  #asMissionSnapshot(live: LiveExecution): MissionSnapshot {
    // Built from the engine's history rather than read from the kernel because
    // the kernel's tasks all name `hermes.step`, and `Replanner` reads
    // `task.handler` to build the recovered step's capability — so it would
    // faithfully produce a plan of envelopes wrapping envelopes. The engine put
    // the real capabilities in, so the engine is the one that can take them out.
    return {
      id: (live.missions.at(-1) ?? live.id) as unknown as MissionId,
      name: live.plan.goal.statement,
      goal: live.plan.goal.statement,
      state: 'failed',
      failurePolicy: live.plan.goal.failurePolicy ?? 'fail-fast',
      metadata: { executionId: live.id },
      createdAt: live.createdAt,
      finishedAt: this.#clock.now(),
      tasks: live.context.snapshot().map((step) => asTaskSnapshot(live, step)),
    };
  }

  #sink(live: LiveExecution): StepSink {
    return {
      results: live.context,
      agents: this.#runtime.agents,

      onStepStart: (step, attempt, input) => {
        live.context.started(step, attempt);
        this.#logger.debug('Step started', { execution: live.id, step, attempt });
        void this.events.emit('step:started', {
          executionId: live.id,
          step: this.#recordOf(live, step),
        });
        void input;
      },

      onStepSuccess: async (step, result) => {
        live.context.succeeded(step, result);
        // Checkpointed here — inside the step, before the kernel is told it
        // succeeded — because this is the only moment the result exists and is
        // not yet depended on. A crash after this point resumes without re-running
        // the step; a crash before it re-runs the step. There is no third option
        // that does not require the kernel to be transactional with a database it
        // must not know about.
        await this.#checkpoint(live);
        await this.events.emit('step:succeeded', {
          executionId: live.id,
          step: this.#recordOf(live, step),
        });
      },

      onStepFailure: (step, thrown) => {
        live.context.failed(step, toStepError(thrown));
        this.#logger.warn('Step failed', {
          execution: live.id,
          step,
          error: toStepError(thrown).message,
        });
        void this.events.emit('step:failed', {
          executionId: live.id,
          step: this.#recordOf(live, step),
        });
      },
    };
  }

  /**
   * The record for a step this engine compiled.
   *
   * `ExecutionContext.record` is honestly optional — it answers for any name a
   * caller asks about. But every step reaching a sink callback was declared by
   * `#begin` from the same plan that produced the task, so here it cannot be
   * missing. Stated once, in one place, rather than asserted at each of the three
   * call sites; and it degrades to a synthesised record rather than a crash,
   * because taking down an event emission over an impossible condition would
   * trade a cosmetic problem for a real one.
   */
  #recordOf(live: LiveExecution, step: string): StepRecord {
    return (
      live.context.record(step) ?? {
        name: step,
        intent: 'unknown',
        capability: { kind: 'tool', name: 'unknown' },
        state: 'pending',
        attempts: 0,
      }
    );
  }

  #failures(live: LiveExecution): readonly Failure[] {
    return live.context.inState('failed').map((step) => ({
      step: step.name,
      error: step.error ?? { name: 'Error', message: 'unknown' },
    }));
  }

  async #settle(
    live: LiveExecution,
    state: ExecutionState,
  ): Promise<ExecutionSnapshot> {
    live.state = state;
    live.finishedAt = this.#clock.now();
    await this.#checkpoint(live);

    const snapshot = this.#snapshot(live);
    await this.events.emit('execution:settled', { execution: snapshot });
    return snapshot;
  }

  async #checkpoint(live: LiveExecution): Promise<void> {
    await this.#checkpoints.save({
      id: live.id,
      state: live.state,
      plan: live.plan,
      steps: live.context.checkpointSteps(),
      missions: [...live.missions],
      attempts: live.attempts,
      createdAt: live.createdAt,
      updatedAt: this.#clock.now(),
      metadata: live.metadata,
    });
    await this.events.emit('execution:checkpointed', {
      id: live.id,
      state: live.state,
    });
  }

  #snapshot(live: LiveExecution): ExecutionSnapshot {
    return {
      id: live.id,
      planId: live.plan.id,
      goal: live.plan.goal,
      state: live.state,
      steps: live.context.snapshot(),
      missions: [...live.missions],
      failurePolicy: live.plan.goal.failurePolicy ?? 'fail-fast',
      attempts: live.attempts,
      createdAt: live.createdAt,
      ...(live.finishedAt === undefined ? {} : { finishedAt: live.finishedAt }),
      metadata: live.metadata,
    };
  }

  #planContext(): PlanContext {
    return {
      // The replanner reads none of these three, and they are injected honestly
      // anyway rather than cast from `{}` — a null object here would be a lie
      // that only breaks when the planner grows a use for them.
      catalog: { list: () => [], find: () => undefined, has: () => false },
      clock: this.#clock,
      logger: this.#logger,
      signal: undefined,
      newPlanId: () => this.#ids('plan') as never,
    };
  }
}

interface Failure {
  readonly step: string;
  readonly error: NonNullable<StepRecord['error']>;
}

function toDecision(failure: Failure): {
  step: string;
  message: string;
  code?: string;
} {
  return {
    step: failure.step,
    message: failure.error.message,
    ...(failure.error.code === undefined ? {} : { code: failure.error.code }),
  };
}

interface LiveExecution {
  readonly id: ExecutionId;
  plan: Plan;
  readonly context: ExecutionContext;
  state: ExecutionState;
  readonly missions: MissionId[];
  attempts: number;
  paused: boolean;
  readonly createdAt: number;
  finishedAt?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  mission(): MissionId;
}

/**
 * Graft a recovered plan's steps onto the original.
 *
 * The recovered plan contains only what was unfinished. The original is kept as
 * the spine — its succeeded steps still matter, because `exclude` needs their
 * names and `$from` still resolves against their results — so the two are merged
 * rather than swapped. A step present in both takes the recovered version, which
 * is the whole point of having replanned.
 */
function mergePlan(original: Plan, recovered: Plan): Plan {
  const replaced = new Map(recovered.steps.map((step) => [step.name, step]));
  return {
    ...original,
    steps: [
      ...original.steps.map((step) => replaced.get(step.name) ?? step),
      // A replan may legitimately introduce steps the original never had.
      ...recovered.steps.filter(
        (step) => !original.steps.some((old) => old.name === step.name),
      ),
    ],
    metadata: {
      ...original.metadata,
      recoveredFrom: original.id,
      recoveryRationale: recovered.rationale,
    },
  };
}

/** One engine step record, in the kernel's vocabulary, for the `Replanner`. */
function asTaskSnapshot(
  live: LiveExecution,
  step: StepRecord,
): MissionSnapshot['tasks'][number] {
  const planStep = live.plan.steps.find((candidate) => candidate.name === step.name);
  return {
    id: `${live.id}:${step.name}` as never,
    missionId: (live.missions.at(-1) ?? live.id) as never,
    name: step.name,
    // `pending` is what the replanner treats as outstanding work; `running` is
    // what it treats as mid-flight and unknown. The engine's states map onto
    // those exactly, which is why this projection is a rename rather than a
    // reinterpretation.
    state: step.state,
    handler: step.capability,
    input: planStep?.input,
    dependsOn: planStep?.dependsOn ?? [],
    priority: planStep?.priority ?? 0,
    attempts: step.attempts,
    maxAttempts: planStep?.maxAttempts ?? 1,
    metadata: { ...planStep?.metadata, intent: step.intent },
    createdAt: live.createdAt,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    result: step.result,
    error:
      step.error === undefined
        ? undefined
        : Object.assign(new Error(step.error.message), step.error),
  };
}

/** The stored view of an execution that is not running here. */
function snapshotOf(checkpoint: ExecutionCheckpoint): ExecutionSnapshot {
  return {
    id: checkpoint.id,
    planId: checkpoint.plan.id,
    goal: checkpoint.plan.goal,
    state: checkpoint.state,
    steps: checkpoint.steps,
    missions: checkpoint.missions,
    failurePolicy: checkpoint.plan.goal.failurePolicy ?? 'fail-fast',
    attempts: checkpoint.attempts,
    createdAt: checkpoint.createdAt,
    metadata: checkpoint.metadata,
  };
}
