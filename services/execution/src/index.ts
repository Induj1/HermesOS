/**
 * @hermes/execution — plans in, results out.
 *
 * The kernel runs a graph of tasks and refuses to know what they mean. The
 * planner decides what the graph is and refuses to run it. This runs it, and
 * adds the one thing neither could: **data flowing from one step to the next**.
 *
 * ## The gap it closes
 *
 * RFC-0001 §11.4 is blunt about the limitation and about its fix:
 *
 * > `dependsOn` is an ordering constraint, not a data flow... If this must
 * > change, the least-bad shape is probably an explicit, kernel-opaque
 * > reference — `input: { $from: 'a' }` resolved by the runtime at dispatch...
 * > New RFC.
 *
 * This is that new RFC (RFC-0004), with one change: resolution happens **above**
 * the kernel, in this package, so the kernel stays frozen and never learns that
 * a payload means anything. Everything it is good at — ordering, concurrency,
 * retry, timeouts, cancellation, the failure policy, the events `@hermes/memory`
 * persists — is still the kernel doing it. None of it is reimplemented here.
 *
 * ## The intended shape of a host
 *
 * ```ts
 * const engine = new ExecutionEngine({ runtime, checkpoints, recovery });
 *
 * // Before start(): the kernel takes plugins only in its `created` state, which
 * // is what makes a running runtime's capabilities knowable.
 * runtime.use(engine.plugin());
 * await runtime.start();
 *
 * const { plan } = await planner.plan({ statement: 'Summarise my day' });
 * const execution = await engine.execute(plan);
 * ```
 *
 * A plan step reads an earlier step's output by naming it:
 *
 * ```ts
 * { name: 'brief', capability: { kind: 'agent', name: 'summariser' },
 *   dependsOn: ['fetch'],                    // required: see `validateRefs`
 *   input: { events: { $from: 'fetch' } } }
 * ```
 *
 * See `docs/rfcs/RFC-0004-execution-engine.md` for why it is shaped this way.
 */

export { ExecutionEngine } from './engine.js';
export type { ExecuteOptions, ExecutionEngineOptions } from './engine.js';

export type {
  ExecutionCheckpoint,
  ExecutionId,
  ExecutionSnapshot,
  ExecutionState,
  SerialisablePlan,
  SerialisableStep,
  StepError,
  StepRecord,
  StepState,
} from './model.js';
export { TERMINAL_EXECUTION_STATES, toExecutionId } from './model.js';

export { ExecutionContext } from './context/execution-context.js';

export {
  containsRef,
  isStepRef,
  referencedSteps,
  resolveRefs,
  validateRefs,
} from './refs.js';
export type { ResultLookup, StepRef } from './refs.js';

export { compileExecution } from './compiler/execution-compiler.js';
export type { CompileExecutionOptions } from './compiler/execution-compiler.js';
export { stepEnvelope, STEP_AGENT_NAME } from './compiler/step-envelope.js';
export type { SinkResolver, StepEnvelope, StepSink } from './compiler/step-envelope.js';

export type { CheckpointStore } from './ports/checkpoint-store.js';
export { InMemoryCheckpointStore } from './ports/in-memory-checkpoint-store.js';

export { NO_RECOVERY, shouldRecover } from './recovery/recovery-policy.js';
export type { RecoveryDecision, RecoveryPolicy } from './recovery/recovery-policy.js';

export type { ExecutionEventMap, ExecutionEventName } from './events.js';

export {
  CheckpointCorruptError,
  ExecutionError,
  ExecutionFailedError,
  ExecutionNotFoundError,
  ExecutionStateError,
  InvalidInputError,
  InvalidReferenceError,
  RecoveryExhaustedError,
  toError,
  toStepError,
} from './errors.js';
export type { ExecutionErrorCode } from './errors.js';
