/**
 * Toolsets — a group of tools, wired in one act.
 *
 * ## Why this is not a new abstraction
 *
 * It is a `Plugin`. The kernel already has the concept, already orders setup,
 * already disposes in reverse, and already refuses duplicate names. A `ToolSet`
 * class with its own registry and lifecycle would be a second, worse plugin
 * system living beside the real one — and the first thing it would need is a way
 * to get its tools into the kernel's registry, which is what a plugin is.
 *
 * So this is a *function that returns a `Plugin`*. Everything it adds is
 * applied on the way through: the permission grant, and the shared metadata that
 * would otherwise be repeated on every tool in the group and forgotten on one.
 */

import { definePlugin } from '@hermes/kernel';
import type { Plugin } from '@hermes/kernel';
import { InvalidDefinitionError } from './errors.js';
import { withPermissions } from './middleware.js';
import type { PermissionSet } from './permissions.js';
import type { AnyHermesTool } from './tool.js';

export interface ToolSetOptions {
  /** The plugin's name. What appears in `plugin:registered` and in errors. */
  readonly name: string;
  readonly version?: string;
  readonly tools: readonly AnyHermesTool[];
  /**
   * Guard every tool with the permissions it declares.
   *
   * Absent means unguarded, and that is the honest default rather than a safe
   * one: this package cannot know whether a host has an authorisation story, and
   * a framework that defaulted to `PermissionSet.none()` would make every tool in
   * a fresh project fail on its first call with a message about a subsystem the
   * author has not built yet.
   *
   * Deciding once, for a whole set, at the composition root is the shape that
   * works. Guarding tools one at a time is how one gets forgotten.
   */
  readonly granted?: PermissionSet;
  /**
   * Tags added to every tool in the set.
   *
   * The thing this function is really for. A filesystem toolset tags all eight of
   * its tools `filesystem` in one place, rather than eight places one of which is
   * wrong — and `NamedTools({ tags: ['filesystem'] })` then selects them as a
   * group, which is how an agent is given a domain rather than a list.
   */
  readonly tags?: readonly string[];
}

/**
 * Wire a group of tools into a kernel runtime.
 *
 * ```ts
 * runtime.use(toolset({
 *   name: 'filesystem',
 *   tags: ['filesystem'],
 *   granted: PermissionSet.none().grant('fs:read'),
 *   tools: [readFile, listDir, writeFile],
 * }));
 * ```
 *
 * With that grant, `writeFile` is registered and refuses at call time — rather
 * than being absent. That is deliberate: a tool that vanishes is indistinguishable
 * from one that was never installed, and a model told nothing will keep looking
 * for it. `catalog({ granted })` is the other half, for a host that wants it
 * hidden from the model as well; the two are separate decisions and this makes
 * both available.
 *
 * @throws {InvalidDefinitionError} for an empty set — a plugin that registers
 *   nothing is a wiring mistake, and it should fail at wiring.
 */
export function toolset(options: ToolSetOptions): Plugin {
  if (options.tools.length === 0) {
    throw new InvalidDefinitionError(options.name, [
      'a toolset must contain at least one tool',
    ]);
  }

  const duplicate = options.tools.find(
    (tool, index) =>
      options.tools.findIndex((other) => other.name === tool.name) !== index,
  )?.name;
  if (duplicate !== undefined) {
    // The kernel's registry would catch this at `start()`, with a message naming
    // the registry rather than the set. Caught here, it names the set the author
    // is looking at.
    throw new InvalidDefinitionError(options.name, [
      `duplicate tool name "${duplicate}"`,
    ]);
  }

  return definePlugin({
    name: options.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    setup: (ctx) => {
      for (const tool of options.tools) {
        ctx.registerTool(prepare(tool, options));
      }
    },
  });
}

/** Apply the set's tags and grant to one tool. */
function prepare(tool: AnyHermesTool, options: ToolSetOptions): AnyHermesTool {
  const tagged: AnyHermesTool =
    options.tags === undefined
      ? tool
      : // The set's tags are added, not replaced. A tool that already declared
        // `read` keeps it and gains `filesystem` — the two say different things,
        // and a set that overwrote them would silently discard the more specific.
        { ...tool, tags: [...new Set([...(tool.tags ?? []), ...options.tags])] };

  return options.granted === undefined
    ? tagged
    : withPermissions(tagged, options.granted);
}
