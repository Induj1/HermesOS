/**
 * Plugin — the only way anything gets into the kernel.
 *
 * The kernel ships with no tools and no agents. Every capability arrives as a
 * plugin, which means the kernel's dependency list never grows as the system
 * does: a Telegram transport, a Postgres store, and a model-backed planner are
 * all just plugins to a runtime that has never heard of any of them.
 *
 * Setup gets a context rather than the Runtime itself, so a plugin can register
 * capabilities and observe events but cannot start missions, reach into the
 * scheduler, or stop the runtime that owns it.
 */

import type { AnyAgent } from './agent.js';
import type { Clock } from './clock.js';
import type { EventBus } from './event-bus.js';
import type { KernelEventMap } from './events.js';
import type { Logger } from './logger.js';
import type { AnyTool } from './tool.js';

export interface PluginContext {
  readonly bus: EventBus<KernelEventMap>;
  /** Already tagged with the plugin's name. */
  readonly logger: Logger;
  readonly clock: Clock;
  registerTool(tool: AnyTool): void;
  registerAgent(agent: AnyAgent): void;
  /**
   * Register a teardown. Runs when the runtime stops, in reverse setup order, so
   * a plugin releases its resources before anything it depended on does.
   */
  onDispose(dispose: () => void | Promise<void>): void;
}

export interface Plugin {
  readonly name: string;
  readonly version?: string;
  /**
   * Names of plugins that must be set up first — e.g. a plugin whose agent needs
   * another's tools registered before it can look at them. The runtime
   * topologically sorts on this and rejects cycles.
   */
  readonly dependsOn?: readonly string[];
  setup(ctx: PluginContext): void | Promise<void>;
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
