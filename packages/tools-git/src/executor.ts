/**
 * The git executor port — running `git`, safely, by reusing the shell package.
 *
 * ## Why this is a wrapper, not a new spawner
 *
 * Running `git` is running a command, and `@hermes/tools-shell` already solved
 * running a command safely: argv-not-a-shell (so injection is unrepresentable), a
 * timeout, an output cap, an isolated environment, and cancellation. Re-solving
 * all of that here would be duplicating the hardest, most security-sensitive code
 * in the tool layer. So {@link ShellGitExecutor} *is* a `ShellExecutor` pinned to
 * one program — `git` — in one place — a confined repository root.
 *
 * That is the payoff of the shell package being a port: a whole other tool
 * package reuses its bounds by holding a `ShellExecutor`, and inherits every fix
 * to it for free.
 *
 * ## What this adds on top
 *
 * Two things the shell layer does not know about, because they are git's:
 *
 * - **Repository confinement.** Every operation runs in a directory under a root,
 *   and a `cwd` that escapes it is refused — the same containment the filesystem
 *   tools give paths (RFC-0007 §4), because a git command with an arbitrary `cwd`
 *   is a way to touch a repository the host never meant to expose.
 * - **A git-shaped result.** `git` communicates through exit codes and stderr in
 *   conventions the tools parse; the executor carries them through faithfully.
 */

import type { ShellExecutor } from '@hermes/tools-shell';
import { GitError } from './errors.js';

export interface GitRunOptions {
  /**
   * Directory to run in, relative to the executor's root. Defaults to the root.
   *
   * Confined: a `cwd` that resolves outside the root is refused with
   * `PATH_ESCAPE` before `git` is spawned.
   */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** What a finished `git` invocation produced. */
export interface GitResult {
  readonly args: readonly string[];
  /** The process exit code. `null` when killed (timeout, signal). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs `git` with the given arguments.
 *
 * `args` is an argv array, passed to `git` untouched — a branch named
 * `; rm -rf ~` is a branch name, not a second command, because the shell executor
 * underneath never sees a command line. Throws {@link GitError} only when `git`
 * could not be run (not installed, cwd escaped); a `git` that ran and failed is a
 * `GitResult` with a non-zero `exitCode`, which the tools interpret.
 */
export interface GitExecutor {
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}

export interface ShellGitExecutorOptions {
  /**
   * The workspace root. Every operation is confined to this directory.
   *
   * Required and with no default: a git executor with no root would run in the
   * process's cwd, which is wherever the host happens to have started — exactly
   * the ambient, unbounded access the confinement exists to prevent.
   */
  readonly root: string;
  /** The git program. Defaults to `git`; set it to pin an absolute path. */
  readonly gitPath?: string;
  /** Default timeout for an operation, in ms. */
  readonly timeoutMs?: number;
}

/**
 * A git executor backed by a shell executor.
 *
 * ```ts
 * const git = new ShellGitExecutor(new NodeShellExecutor(), { root: '/srv/repos' });
 * ```
 *
 * The shell executor should allow `git` (an `allowlisted(shell, ['git'])`), so
 * that even this narrow wrapper cannot be talked into running anything else.
 */
export class ShellGitExecutor implements GitExecutor {
  readonly #shell: ShellExecutor;
  readonly #options: ShellGitExecutorOptions;

  constructor(shell: ShellExecutor, options: ShellGitExecutorOptions) {
    this.#shell = shell;
    this.#options = options;
  }

  async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const cwd = confine(this.#options.root, options.cwd ?? '.');
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs;

    const result = await this.#shell.run(this.#options.gitPath ?? 'git', args, {
      cwd,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return {
      args: [...args],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }
}

/**
 * Resolve a directory within a root, or refuse it.
 *
 * The same POSIX-style containment the filesystem tools use — a pure function of
 * two strings, no disk access, so no TOCTOU gap — kept here rather than imported
 * because tying git to the filesystem *tools* package for one function would be a
 * worse coupling than a small, tested duplication. If a third consumer appears,
 * it earns its own shared home (rule of three); RFC-0010 §7 records the call.
 */
export function confine(root: string, path: string): string {
  const rootParts = split(root);
  const parts = [...rootParts];

  for (const segment of split(path)) {
    if (segment === '..') {
      if (parts.length <= rootParts.length) {
        throw new GitError(
          'PATH_ESCAPE',
          `"${path}" resolves outside the repository root`,
        );
      }
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  return '/' + parts.join('/');
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}
