/**
 * Runtime — the composition root and the kernel's only public entry point.
 *
 * It owns the pieces (bus, registries, scheduler), the plugin lifecycle, and the
 * one thing nothing else could own: turning a task's `{ kind, name }` handler
 * reference into an actual call. The scheduler decides *when*; the runtime knows
 * *what*.
 *
 * Its own lifecycle is a state machine, so "submit a mission to a stopped
 * runtime" and "register a plugin after start" fail with a clear error instead of
 * a subtle one.
 */

import type { AnyAgent } from './agent.js';
import { systemClock, type Clock } from './clock.js';
import {
  CancellationError,
  NotFoundError,
  PluginError,
  RuntimeStateError,
  toError,
} from './errors.js';
import { EventBus } from './event-bus.js';
import type { KernelEventMap } from './events.js';
import { topoSort } from './graph.js';
import { randomIds, type IdGenerator, type MissionId } from './ids.js';
import { StateMachine, type TransitionMap } from './lifecycle.js';
import { noopLogger, type Logger } from './logger.js';
import { Mission, type MissionSnapshot, type MissionSpec } from './mission.js';
import type { Plugin, PluginContext } from './plugin.js';
import { Registry, type ReadonlyRegistry } from './registry.js';
import { Scheduler, type RetryDelay } from './scheduler.js';
import type { Task } from './task.js';
import type { AnyTool, ExecutionContext, ToolAccess } from './tool.js';

export type RuntimeState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

/** `stopped` is terminal: a stopped runtime is built again, not revived. */
export const RUNTIME_TRANSITIONS = {
  // created -> stopped: stopping a runtime that never started is a no-op, not an
  // error, so shutdown paths do not have to know whether start() got that far.
  created: ['starting', 'stopped'],
  starting: ['running', 'stopped'],
  running: ['stopping'],
  stopping: ['stopped'],
  stopped: [],
} as const satisfies TransitionMap<RuntimeState>;

export interface RuntimeOptions {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Max tasks in flight across all missions. Default 4. */
  readonly concurrency?: number;
  readonly retryDelay?: RetryDelay;
}

export interface StopOptions {
  /**
   * `drain`  — let in-flight missions finish (default).
   * `cancel` — abort them now.
   */
  readonly mode?: 'drain' | 'cancel';
}

interface RegisteredPlugin {
  readonly plugin: Plugin;
  readonly disposers: (() => void | Promise<void>)[];
}

export class Runtime {
  readonly bus: EventBus<KernelEventMap>;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #tools = new Registry<AnyTool>('tool');
  readonly #agents = new Registry<AnyAgent>('agent');
  readonly #plugins: RegisteredPlugin[] = [];
  readonly #pending: Plugin[] = [];
  readonly #scheduler: Scheduler;
  readonly #machine: StateMachine<RuntimeState>;

  private constructor(options: RuntimeOptions) {
    this.#logger = options.logger ?? noopLogger;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? randomIds;
    this.#machine = new StateMachine<RuntimeState>('created', RUNTIME_TRANSITIONS, {
      subject: 'runtime',
    });

    // A listener that throws becomes an event, not a crash. Without this a bad
    // subscriber could take down the scheduler mid-mission.
    this.bus = new EventBus<KernelEventMap>({
      onListenerError: (error, event) => {
        this.#logger.error('Event listener threw', {
          event: event.type,
          error: error.message,
        });
        void this.bus.emit('kernel:error', {
          error,
          context: `listener for "${event.type}"`,
          missionId: undefined,
          taskId: undefined,
        });
      },
    });

    this.#scheduler = new Scheduler({
      bus: this.bus,
      clock: this.#clock,
      logger: this.#logger,
      executor: (task, signal) => this.#execute(task, signal),
      ...(options.concurrency !== undefined
        ? { concurrency: options.concurrency }
        : {}),
      ...(options.retryDelay !== undefined ? { retryDelay: options.retryDelay } : {}),
    });
  }

  static create(options: RuntimeOptions = {}): Runtime {
    return new Runtime(options);
  }

  get state(): RuntimeState {
    return this.#machine.state;
  }

  /** Read-only by design: capabilities enter through plugins, not the back door. */
  get tools(): ReadonlyRegistry<AnyTool> {
    return this.#tools;
  }

  get agents(): ReadonlyRegistry<AnyAgent> {
    return this.#agents;
  }

  /**
   * Queue a plugin. Setup runs at `start()`, in dependency order — so
   * registration order at the call site does not matter, and `dependsOn` does.
   */
  use(plugin: Plugin): this {
    if (this.state !== 'created') {
      throw new RuntimeStateError(
        `Plugins must be registered before start() (runtime is "${this.state}")`,
      );
    }
    this.#pending.push(plugin);
    return this;
  }

  /** Set up every plugin, then begin dispatching. */
  async start(): Promise<void> {
    this.#machine.to('starting');
    await this.bus.emit('runtime:starting', { at: this.#clock.now() });

    try {
      for (const plugin of this.#orderPlugins()) {
        await this.#setupPlugin(plugin);
      }
    } catch (error) {
      // Half-initialised is worse than not initialised: unwind what did come up.
      this.#machine.to('stopped');
      await this.#disposePlugins();
      throw error;
    }

    this.#scheduler.start();
    this.#machine.to('running');
    await this.bus.emit('runtime:started', { at: this.#clock.now() });
  }

  /**
   * Stop dispatching, settle or cancel outstanding work, then dispose plugins in
   * reverse setup order.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    const mode = options.mode ?? 'drain';
    if (this.state === 'stopped') return;
    if (this.state === 'created') {
      this.#machine.to('stopped');
      return;
    }
    this.#machine.to('stopping');
    await this.bus.emit('runtime:stopping', { at: this.#clock.now(), mode });

    if (mode === 'cancel') {
      await this.#scheduler.cancelAll('Runtime stopping');
    }
    await this.#scheduler.drain();
    this.#scheduler.stop();

    await this.#disposePlugins();
    this.#machine.to('stopped');
    await this.bus.emit('runtime:stopped', { at: this.#clock.now() });
  }

  /**
   * Validate and submit a mission. Resolves with the final snapshot when every
   * task is terminal — including when the mission fails, which is a result to
   * inspect rather than an exception to catch.
   */
  async run(spec: MissionSpec): Promise<MissionSnapshot> {
    return await this.#scheduler.submit(this.createMission(spec));
  }

  /**
   * Submit without waiting. Returns the Mission so the caller can hold its id and
   * follow it on the bus — use {@link Runtime.run} when you want the snapshot,
   * or {@link Runtime.idle} to wait for everything at once.
   */
  submit(spec: MissionSpec): Mission {
    const mission = this.createMission(spec);
    void this.#scheduler.submit(mission);
    return mission;
  }

  /** Build and validate a mission without submitting it. */
  createMission(spec: MissionSpec): Mission {
    if (this.state !== 'running') {
      throw new RuntimeStateError(
        `Runtime must be running to accept missions (it is "${this.state}")`,
      );
    }
    return Mission.create(spec, { ids: this.#ids, now: this.#clock.now() });
  }

  async cancelMission(missionId: MissionId, reason?: string): Promise<void> {
    await this.#scheduler.cancelMission(missionId, reason);
  }

  /** Resolve once no work is running, retrying, or runnable. */
  async idle(): Promise<void> {
    await this.#scheduler.drain();
  }

  #orderPlugins(): readonly Plugin[] {
    const sorted = topoSort(
      this.#pending.map((plugin) => ({
        id: plugin.name,
        dependsOn: plugin.dependsOn ?? [],
      })),
    );
    if (!sorted.ok) {
      if (sorted.reason === 'duplicate')
        throw new RuntimeStateError(`Duplicate plugin name "${sorted.id}"`);
      if (sorted.reason === 'missing') {
        throw new RuntimeStateError(
          `Plugin "${sorted.from}" depends on "${sorted.missing}", which is not registered`,
        );
      }
      throw new RuntimeStateError(
        `Plugin dependency cycle: ${sorted.cycle.join(' -> ')}`,
      );
    }
    const byName = new Map(this.#pending.map((plugin) => [plugin.name, plugin]));
    return sorted.order
      .map((node) => byName.get(node.id))
      .filter((plugin): plugin is Plugin => plugin !== undefined);
  }

  async #setupPlugin(plugin: Plugin): Promise<void> {
    const registered: RegisteredPlugin = { plugin, disposers: [] };
    const ctx: PluginContext = {
      bus: this.bus,
      clock: this.#clock,
      logger: this.#logger.child({ plugin: plugin.name }),
      registerTool: (tool) => {
        this.#tools.register(tool);
      },
      registerAgent: (agent) => {
        this.#agents.register(agent);
      },
      onDispose: (dispose) => registered.disposers.push(dispose),
    };

    try {
      await plugin.setup(ctx);
    } catch (thrown) {
      // Pushed first so anything it did register before throwing still unwinds.
      this.#plugins.push(registered);
      throw new PluginError(plugin.name, 'setup', thrown);
    }

    this.#plugins.push(registered);
    await this.bus.emit('plugin:registered', {
      name: plugin.name,
      version: plugin.version,
    });
  }

  /**
   * Reverse setup order, and one plugin's failure never blocks the next one's
   * teardown — a leaked handle in plugin A must not leak plugin B's too.
   */
  async #disposePlugins(): Promise<void> {
    for (const registered of [...this.#plugins].reverse()) {
      for (const dispose of [...registered.disposers].reverse()) {
        try {
          await dispose();
        } catch (thrown) {
          const error = new PluginError(registered.plugin.name, 'dispose', thrown);
          this.#logger.error('Plugin dispose failed', {
            plugin: registered.plugin.name,
          });
          await this.bus.emit('kernel:error', {
            error,
            context: `dispose of plugin "${registered.plugin.name}"`,
            missionId: undefined,
            taskId: undefined,
          });
        }
      }
      await this.bus.emit('plugin:disposed', { name: registered.plugin.name });
    }
    this.#plugins.length = 0;
  }

  /** Resolve a task's handler reference and run it. This is the executor. */
  async #execute(task: Task, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new CancellationError('Cancelled before start');

    const ctx: ExecutionContext = {
      missionId: task.missionId,
      taskId: task.id,
      taskName: task.name,
      attempt: task.attempts,
      signal,
      clock: this.#clock,
      logger: this.#logger.child({ mission: task.missionId, task: task.name }),
    };

    if (task.handler.kind === 'tool') {
      return await this.#invokeTool(task.handler.name, task.input, ctx);
    }

    const agent = this.#agents.get(task.handler.name);
    if (!agent) throw new NotFoundError('agent', task.handler.name);
    const input = agent.input ? agent.input.parse(task.input) : task.input;
    return await agent.handle(input, { ...ctx, tools: this.#toolAccess(ctx) });
  }

  async #invokeTool(
    name: string,
    rawInput: unknown,
    ctx: ExecutionContext,
  ): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new NotFoundError('tool', name);

    // A task's input arrives as unknown — it came from a plain spec, possibly off
    // a wire. This is the one place it becomes the tool's own type, and `parse`
    // is what earns that: a tool declaring a validator gets its input checked
    // here rather than trusted downstream.
    const input = tool.input ? tool.input.parse(rawInput) : rawInput;
    const output = await tool.execute(input, ctx);
    return tool.output ? tool.output.parse(output) : output;
  }

  /** The tool surface an agent sees: same context, same signal, same deadline. */
  #toolAccess(ctx: ExecutionContext): ToolAccess {
    return {
      has: (name) => this.#tools.has(name),
      list: () =>
        this.#tools
          .list()
          .map((tool) => ({ name: tool.name, description: tool.description })),
      invoke: async (name, input) => {
        if (ctx.signal.aborted) throw new CancellationError('Cancelled');
        try {
          return await this.#invokeTool(name, input, ctx);
        } catch (thrown) {
          const error = toError(thrown);
          ctx.logger.warn('Tool invocation failed', {
            tool: name,
            error: error.message,
          });
          throw error;
        }
      },
    };
  }
}
