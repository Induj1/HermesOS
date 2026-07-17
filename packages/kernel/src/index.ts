/**
 * @hermes/kernel — the Hermes core runtime.
 *
 * The kernel knows how to run a graph of tasks toward a goal, and nothing else.
 * It has no dependencies, talks to no network, touches no database, and contains
 * no AI. Everything concrete arrives as a {@link Plugin} registering
 * {@link Tool}s and {@link Agent}s; everything observable leaves through the
 * {@link EventBus}.
 *
 * The intended shape of a host:
 *
 * ```ts
 * const runtime = Runtime.create({ concurrency: 8 });
 * runtime.use(calendarPlugin).use(plannerPlugin);
 * await runtime.start();
 *
 * const result = await runtime.run({
 *   name: 'morning-brief',
 *   goal: 'Summarise the day ahead',
 *   tasks: [
 *     { name: 'fetch', handler: { kind: 'tool', name: 'calendar.today' } },
 *     { name: 'brief', handler: { kind: 'agent', name: 'summariser' }, dependsOn: ['fetch'] },
 *   ],
 * });
 *
 * await runtime.stop();
 * ```
 */

export { Runtime, RUNTIME_TRANSITIONS } from './runtime.js';
export type { RuntimeOptions, RuntimeState, StopOptions } from './runtime.js';

export { Mission, MISSION_TRANSITIONS } from './mission.js';
export type {
  FailurePolicy,
  MissionDeps,
  MissionSnapshot,
  MissionSpec,
  MissionState,
} from './mission.js';

export { Task, TASK_TRANSITIONS } from './task.js';
export type {
  TaskHandlerRef,
  TaskInit,
  TaskSnapshot,
  TaskSpec,
  TaskState,
} from './task.js';

export { Scheduler, defaultRetryDelay } from './scheduler.js';
export type { RetryDelay, SchedulerOptions, TaskExecutor } from './scheduler.js';

export { EventBus } from './event-bus.js';
export type {
  EmittedEvent,
  EventBusOptions,
  EventMap,
  Listener,
  Subscription,
  WaitForOptions,
} from './event-bus.js';
export type { KernelEventMap, KernelEventName } from './events.js';

export { StateMachine } from './lifecycle.js';
export type { StateMachineOptions, TransitionMap } from './lifecycle.js';

export { Registry } from './registry.js';
export type { ReadonlyRegistry } from './registry.js';

export { defineTool } from './tool.js';
export type {
  AnyTool,
  ExecutionContext,
  Tool,
  ToolAccess,
  ToolContext,
  Validator,
} from './tool.js';

export { defineAgent } from './agent.js';
export type { Agent, AgentContext, AnyAgent } from './agent.js';

export { definePlugin } from './plugin.js';
export type { Plugin, PluginContext } from './plugin.js';

export { systemClock, TestClock } from './clock.js';
export type { Clock } from './clock.js';

export { noopLogger } from './logger.js';
export type { LogFields, Logger } from './logger.js';

export { randomIds, sequentialIds, toMissionId, toTaskId } from './ids.js';
export type { Brand, IdGenerator, MissionId, TaskId } from './ids.js';

export { topoSort } from './graph.js';
export type { GraphNode, TopoResult } from './graph.js';

export {
  CancellationError,
  DuplicateRegistrationError,
  InvalidTransitionError,
  KernelError,
  MissionValidationError,
  NotFoundError,
  PluginError,
  RuntimeStateError,
  TaskTimeoutError,
  toError,
} from './errors.js';
export type { KernelErrorCode } from './errors.js';
