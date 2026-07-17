/**
 * @hermes/tools-shell — run commands, safely enough to hand a model.
 *
 * The whole package rests on one decision: `shell.run` takes a program and an
 * **argv array**, never a command string, and {@link NodeShellExecutor} spawns it
 * with **no shell** ({@link ShellExecutor}). So command injection is not
 * mitigated — it is unrepresentable, because there is no string for a shell to
 * interpret. Layered on top: an {@link allowlisted} executor (default deny, by
 * program name), a timeout, an output cap, an isolated environment, and
 * cancellation.
 *
 * ```ts
 * import { shellToolset, NodeShellExecutor } from '@hermes/tools-shell';
 * import { PermissionSet } from '@hermes/tools';
 *
 * runtime.use(shellToolset({
 *   executor: new NodeShellExecutor({ cwd: '/srv/workspace' }),
 *   allow: ['git', 'ls', 'cat'],                          // only these programs
 *   granted: PermissionSet.none().grant('shell:exec'),    // opt in explicitly
 * }));
 * ```
 *
 * See `docs/rfcs/RFC-0008-shell-tools.md` for why it is shaped this way.
 */

export { shellTools } from './tools.js';
export type { ShellToolsOptions } from './tools.js';

export { shellToolset } from './toolset.js';
export type { ShellToolsetOptions } from './toolset.js';

export { allowlisted } from './executor.js';
export type { ShellExecutor, ShellResult, ShellRunOptions } from './executor.js';

export { NodeShellExecutor } from './node-executor.js';
export type { NodeShellExecutorOptions } from './node-executor.js';

export { FakeShellExecutor } from './fake-executor.js';
export type {
  FakeHandler,
  FakeResult,
  FakeShellExecutorOptions,
} from './fake-executor.js';

export { ShellError, fromSpawnError } from './errors.js';
export type { ShellErrorCode } from './errors.js';
