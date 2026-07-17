/**
 * @hermes/tools-git — drive `git` from an agent, within bounds.
 *
 * The package is a thin, safe layer over `git`, and its two ideas are:
 *
 * 1. **Reuse the shell package's safety.** {@link ShellGitExecutor} holds a
 *    `ShellExecutor` and pins it to `git`, so it inherits argv-not-a-shell (no
 *    injection), timeouts, output caps, an isolated environment, and cancellation
 *    for free — and every future fix to the shell layer with it.
 * 2. **Structured reads, honest writes.** The read tools parse git's *stable*
 *    porcelain formats into data a model reasons about; the rest carry git's own
 *    exit codes and messages through, and turn expected failures — a merge
 *    conflict, a rejected push — into reported outcomes, not thrown errors.
 *
 * Permissions come in three grades — `git:read`, `git:write`, `git:network` — so a
 * host grants exactly the reach it means to.
 *
 * ```ts
 * import { gitToolset, ShellGitExecutor } from '@hermes/tools-git';
 * import { NodeShellExecutor, allowlisted } from '@hermes/tools-shell';
 * import { PermissionSet } from '@hermes/tools';
 *
 * const shell = allowlisted(new NodeShellExecutor(), ['git']);
 * runtime.use(gitToolset({
 *   executor: new ShellGitExecutor(shell, { root: '/srv/workspace' }),
 *   granted: PermissionSet.none().grant('git:read').grant('git:write'),
 * }));
 * ```
 *
 * See `docs/rfcs/RFC-0010-git-tools.md` for the design.
 */

export { gitTools, GitError } from './tools.js';
export type { GitToolsOptions } from './tools.js';

export { gitToolset } from './toolset.js';
export type { GitToolsetOptions } from './toolset.js';

export { ShellGitExecutor, confine } from './executor.js';
export type {
  GitExecutor,
  GitResult,
  GitRunOptions,
  ShellGitExecutorOptions,
} from './executor.js';

export { FakeGitExecutor } from './fake-executor.js';
export type {
  FakeGitHandler,
  FakeGitResult,
  FakeGitExecutorOptions,
} from './fake-executor.js';

export { classifyGitFailure } from './errors.js';
export type { GitErrorCode } from './errors.js';

export { parseStatus, parseLog, parseBranches, LOG_FORMAT } from './parse.js';
export type { Status, StatusEntry, LogEntry, Branches } from './parse.js';
