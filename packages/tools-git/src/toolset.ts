/**
 * The git toolset — the one call a host makes.
 *
 * The default grant is **`git:read` only**: inspecting history is safe to hand a
 * model, changing it or talking to a remote is a deliberate escalation. This
 * mirrors the filesystem toolset (read by default) rather than the shell toolset
 * (nothing by default), because git — unlike a bare shell — has a genuinely safe
 * read-only subset worth offering out of the box.
 *
 * A host that wants writes grants `git:write`; one that wants push/pull grants
 * `git:network`. Those two grants, together, are the whole audit trail of what an
 * agent may do to a repository.
 */

import { PermissionSet, toolset } from '@hermes/tools';
import type { Plugin } from '@hermes/kernel';
import type { GitExecutor } from './executor.js';
import { gitTools, type GitToolsOptions } from './tools.js';

export interface GitToolsetOptions extends GitToolsOptions {
  /**
   * The executor. Required. Usually a {@link ShellGitExecutor} over an
   * `allowlisted` shell executor, or a {@link FakeGitExecutor} in tests.
   *
   * No default: an executor is what actually runs `git`, and defaulting to one
   * would be this package deciding a host may run git without the host saying so.
   */
  readonly executor: GitExecutor;
  /**
   * What the tools are permitted to do. Defaults to read-only (`git:read`).
   *
   * Grant `git:write` for local history changes, `git:network` for remote sync:
   * `PermissionSet.none().grant('git:read').grant('git:write')`.
   */
  readonly granted?: PermissionSet;
  readonly name?: string;
}

/**
 * Wire git tools into a runtime.
 *
 * ```ts
 * runtime.use(gitToolset({
 *   executor: new ShellGitExecutor(shell, { root: '/srv/workspace' }),
 *   granted: PermissionSet.none().grant('git:read').grant('git:write'),
 * }));
 * ```
 */
export function gitToolset(options: GitToolsetOptions): Plugin {
  return toolset({
    name: options.name ?? 'git',
    tags: ['git'],
    granted: options.granted ?? PermissionSet.none().grant('git:read'),
    tools: gitTools(options.executor, options),
  });
}
