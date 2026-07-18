/**
 * The git tools.
 *
 * A tool per operation, grouped by the permission they need:
 *
 * - **`git:read`** — status, log, diff, branches, tags, show. Never change the
 *   repository.
 * - **`git:write`** — init, add, commit, checkout, branch, merge, rebase, stash,
 *   tag, reset. Change the working tree or local history.
 * - **`git:network`** — clone, fetch, pull, push. Talk to a remote.
 *
 * The three-way split is the point: a host can grant an agent read-only history
 * (`git:read`), or local edits without the ability to push (`+ git:write`), or
 * full sync (`+ git:network`), and each is a deliberate, auditable grant.
 *
 * The read tools return **structured** output (parsed status, log entries) so a
 * model reasons about data rather than scraping prose. The rest return the exit
 * code and output, because git's own messages are what a human expects and a
 * model can read.
 */

import { defineTool, s, type HermesTool } from '@hermes/tools';
import type { ToolContext } from '@hermes/kernel';
import type { GitExecutor, GitResult } from './executor.js';
import { assertCloneUrlSafe, classifyGitFailure, GitError } from './errors.js';
import { LOG_FORMAT, parseBranches, parseLog, parseStatus } from './parse.js';

export interface GitToolsOptions {
  /** Default timeout for an operation, in ms. Network operations may want more. */
  readonly timeoutMs?: number;
}

/** The plain result the pass-through tools return. */
const runResult = s.object({
  exitCode: s.optional(s.number({ integer: true })),
  stdout: s.string(),
  stderr: s.string(),
});

export function gitTools(
  executor: GitExecutor,
  options: GitToolsOptions = {},
): readonly HermesTool[] {
  /** Run git, throwing a classified error on a non-zero exit unless told not to. */
  const git = async (
    subcommand: string,
    args: readonly string[],
    ctx: ToolContext,
    opts: { allowFail?: boolean } = {},
  ): Promise<GitResult> => {
    const result = await executor.run(args, {
      signal: ctx.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (result.exitCode !== 0 && opts.allowFail !== true) {
      throw classifyGitFailure(subcommand, result.stderr, result.stdout);
    }
    return result;
  };

  const passthrough = (
    result: GitResult,
  ): { exitCode: number | undefined; stdout: string; stderr: string } => ({
    // `undefined`, not omitted: the output schema declares `exitCode` present (a
    // killed run reports `null` as `undefined`), which `exactOptionalPropertyTypes`
    // distinguishes from an absent key.
    exitCode: result.exitCode ?? undefined,
    stdout: result.stdout,
    stderr: result.stderr,
  });

  // ── read ──────────────────────────────────────────────────────────────────

  const status = defineTool({
    name: 'git.status',
    description:
      'Show the working-tree status: branch, ahead/behind, and changed files, structured.',
    tags: ['git', 'read'],
    permissions: ['git:read'],
    idempotent: true,
    input: s.object({}),
    output: s.object({
      branch: s.optional(s.string()),
      ahead: s.number({ integer: true }),
      behind: s.number({ integer: true }),
      clean: s.boolean(),
      entries: s.array(
        s.object({
          path: s.string(),
          state: s.enumOf(['staged', 'unstaged', 'both', 'untracked']),
          code: s.string(),
        }),
      ),
    }),
    examples: [{ description: 'Check what has changed', input: {} }],
    execute: async (_input, ctx) => {
      const result = await git('status', ['status', '--porcelain=v1', '--branch'], ctx);
      const parsed = parseStatus(result.stdout);
      return {
        branch: parsed.branch,
        ahead: parsed.ahead,
        behind: parsed.behind,
        clean: parsed.clean,
        entries: parsed.entries.map((e) => ({
          path: e.path,
          state: e.state,
          code: e.code,
        })),
      };
    },
  });

  const log = defineTool({
    name: 'git.log',
    description:
      'List recent commits as structured entries (hash, author, date, subject).',
    tags: ['git', 'read'],
    permissions: ['git:read'],
    idempotent: true,
    input: s.object({
      limit: s.withDefault(s.number({ integer: true, minimum: 1, maximum: 1000 }), 20),
      ref: s.optional(
        s.string({ description: 'Branch, tag, or ref to log. Defaults to HEAD.' }),
      ),
    }),
    output: s.array(
      s.object({
        hash: s.string(),
        author: s.string(),
        email: s.string(),
        date: s.string(),
        subject: s.string(),
      }),
    ),
    examples: [{ description: 'Last 5 commits', input: { limit: 5 } }],
    execute: async ({ limit, ref }, ctx) => {
      const args = ['log', `--max-count=${String(limit)}`, `--format=${LOG_FORMAT}`];
      if (ref !== undefined) args.push(ref);
      const result = await git('log', args, ctx);
      return parseLog(result.stdout).map((e) => ({ ...e }));
    },
  });

  const diff = defineTool({
    name: 'git.diff',
    description:
      'Show changes as a unified diff. Staged changes with `staged: true`, otherwise unstaged.',
    tags: ['git', 'read'],
    permissions: ['git:read'],
    idempotent: true,
    input: s.object({
      staged: s.withDefault(
        s.boolean({ description: 'Diff the staged changes rather than the unstaged.' }),
        false,
      ),
      path: s.optional(s.string({ description: 'Limit the diff to this path.' })),
    }),
    output: s.object({ diff: s.string(), empty: s.boolean() }),
    examples: [{ description: 'What is staged', input: { staged: true } }],
    execute: async ({ staged, path }, ctx) => {
      const args = ['diff'];
      if (staged) args.push('--staged');
      if (path !== undefined) args.push('--', path);
      const result = await git('diff', args, ctx);
      return { diff: result.stdout, empty: result.stdout.trim() === '' };
    },
  });

  const branches = defineTool({
    name: 'git.branches',
    description: 'List local branches and which one is checked out.',
    tags: ['git', 'read'],
    permissions: ['git:read'],
    idempotent: true,
    input: s.object({}),
    output: s.object({ current: s.optional(s.string()), all: s.array(s.string()) }),
    examples: [{ description: 'List branches', input: {} }],
    execute: async (_input, ctx) => {
      const result = await git('branch', ['branch', '--list'], ctx);
      const parsed = parseBranches(result.stdout);
      return { current: parsed.current, all: [...parsed.all] };
    },
  });

  const tags = defineTool({
    name: 'git.tags',
    description: 'List tags in the repository.',
    tags: ['git', 'read'],
    permissions: ['git:read'],
    idempotent: true,
    input: s.object({}),
    output: s.object({ tags: s.array(s.string()) }),
    examples: [{ description: 'List tags', input: {} }],
    execute: async (_input, ctx) => {
      const result = await git('tag', ['tag', '--list'], ctx);
      return {
        tags: result.stdout
          .split('\n')
          .map((t) => t.trim())
          .filter((t) => t !== ''),
      };
    },
  });

  const show = defineTool({
    name: 'git.show',
    description: 'Show a commit, its message, and its diff.',
    tags: ['git', 'read'],
    permissions: ['git:read'],
    idempotent: true,
    input: s.object({
      ref: s.withDefault(
        s.string({ description: 'The commit or ref to show.' }),
        'HEAD',
      ),
    }),
    output: runResult,
    examples: [{ description: 'Show the latest commit', input: {} }],
    execute: async ({ ref }, ctx) => passthrough(await git('show', ['show', ref], ctx)),
  });

  // ── write ─────────────────────────────────────────────────────────────────

  const init = defineTool({
    name: 'git.init',
    description: 'Initialise a new git repository in the working directory.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: true,
    input: s.object({}),
    output: runResult,
    examples: [{ description: 'Start a repository', input: {} }],
    execute: async (_input, ctx) => passthrough(await git('init', ['init'], ctx)),
  });

  const add = defineTool({
    name: 'git.add',
    description:
      'Stage files for the next commit. Pass paths, or `["."]` for everything.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: true,
    input: s.object({
      paths: s.array(s.string(), { minItems: 1, description: 'Paths to stage.' }),
    }),
    output: runResult,
    examples: [{ description: 'Stage everything', input: { paths: ['.'] } }],
    execute: async ({ paths }, ctx) =>
      passthrough(await git('add', ['add', '--', ...paths], ctx)),
  });

  const commit = defineTool({
    name: 'git.commit',
    description:
      'Commit the staged changes with a message. Fails if nothing is staged.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      message: s.string({ minLength: 1, description: 'The commit message.' }),
      all: s.withDefault(
        s.boolean({ description: 'Stage all tracked changes first (git commit -a).' }),
        false,
      ),
    }),
    output: runResult,
    examples: [{ description: 'Commit', input: { message: 'Fix the bug' } }],
    execute: async ({ message, all }, ctx) => {
      const args = ['commit', '-m', message];
      if (all) args.push('-a');
      return passthrough(await git('commit', args, ctx));
    },
  });

  const checkout = defineTool({
    name: 'git.checkout',
    description:
      'Switch to a branch or restore files. With `create: true`, make and switch to a new branch.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      target: s.string({ description: 'A branch name, or a path to restore.' }),
      create: s.withDefault(
        s.boolean({ description: 'Create the branch (git checkout -b).' }),
        false,
      ),
    }),
    output: runResult,
    examples: [
      {
        description: 'New feature branch',
        input: { target: 'feature/x', create: true },
      },
    ],
    execute: async ({ target, create }, ctx) => {
      const args = create ? ['checkout', '-b', target] : ['checkout', target];
      return passthrough(await git('checkout', args, ctx));
    },
  });

  const branch = defineTool({
    name: 'git.branch',
    description: 'Create or delete a branch.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      name: s.string({ description: 'The branch name.' }),
      action: s.withDefault(s.enumOf(['create', 'delete']), 'create'),
    }),
    output: runResult,
    examples: [
      { description: 'Delete a branch', input: { name: 'old', action: 'delete' } },
    ],
    execute: async ({ name, action }, ctx) => {
      const args = action === 'delete' ? ['branch', '-D', name] : ['branch', name];
      return passthrough(await git('branch', args, ctx));
    },
  });

  const merge = defineTool({
    name: 'git.merge',
    description:
      'Merge a branch into the current one. A merge conflict is reported, not thrown.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({ branch: s.string({ description: 'The branch to merge in.' }) }),
    output: s.object({
      merged: s.boolean(),
      conflict: s.boolean(),
      stdout: s.string(),
      stderr: s.string(),
    }),
    examples: [{ description: 'Merge a feature', input: { branch: 'feature/x' } }],
    execute: async ({ branch: toMerge }, ctx) => {
      // allowFail: a conflict is a normal, reportable outcome an agent resolves,
      // not an error that ends the session (RFC-0005 §5.4).
      const result = await git('merge', ['merge', toMerge], ctx, { allowFail: true });
      const conflict =
        result.exitCode !== 0 && /conflict/i.test(result.stdout + result.stderr);
      return {
        merged: result.exitCode === 0,
        conflict,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });

  const rebase = defineTool({
    name: 'git.rebase',
    description:
      'Rebase the current branch onto another. A conflict is reported, not thrown.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      onto: s.string({ description: 'The branch or ref to rebase onto.' }),
      abort: s.withDefault(
        s.boolean({ description: 'Abort an in-progress rebase instead.' }),
        false,
      ),
    }),
    output: s.object({
      ok: s.boolean(),
      conflict: s.boolean(),
      stdout: s.string(),
      stderr: s.string(),
    }),
    examples: [{ description: 'Rebase onto main', input: { onto: 'main' } }],
    execute: async ({ onto, abort }, ctx) => {
      const args = abort ? ['rebase', '--abort'] : ['rebase', onto];
      const result = await git('rebase', args, ctx, { allowFail: true });
      const conflict =
        result.exitCode !== 0 && /conflict/i.test(result.stdout + result.stderr);
      return {
        ok: result.exitCode === 0,
        conflict,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });

  const stash = defineTool({
    name: 'git.stash',
    description: 'Save, restore, or list stashed changes.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      action: s.withDefault(s.enumOf(['push', 'pop', 'list']), 'push'),
    }),
    output: runResult,
    examples: [{ description: 'Stash changes', input: { action: 'push' } }],
    execute: async ({ action }, ctx) =>
      passthrough(await git('stash', ['stash', action], ctx)),
  });

  const tag = defineTool({
    name: 'git.tag',
    description: 'Create a tag at the current commit.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      name: s.string({ description: 'The tag name.' }),
      message: s.optional(
        s.string({ description: 'An annotation; makes an annotated tag.' }),
      ),
    }),
    output: runResult,
    examples: [{ description: 'Tag a release', input: { name: 'v1.0.0' } }],
    execute: async ({ name, message }, ctx) => {
      const args =
        message === undefined ? ['tag', name] : ['tag', '-a', name, '-m', message];
      return passthrough(await git('tag', args, ctx));
    },
  });

  const reset = defineTool({
    name: 'git.reset',
    description:
      'Reset the current branch to a ref. `mode: hard` discards working changes.',
    tags: ['git', 'write'],
    permissions: ['git:write'],
    idempotent: false,
    input: s.object({
      ref: s.withDefault(s.string({ description: 'The ref to reset to.' }), 'HEAD'),
      mode: s.withDefault(s.enumOf(['soft', 'mixed', 'hard']), 'mixed'),
    }),
    output: runResult,
    examples: [{ description: 'Unstage everything', input: {} }],
    execute: async ({ ref, mode }, ctx) =>
      passthrough(await git('reset', ['reset', `--${mode}`, ref], ctx)),
  });

  // ── network ─────────────────────────────────────────────────────────────────

  const clone = defineTool({
    name: 'git.clone',
    description: 'Clone a repository into a directory under the workspace root.',
    tags: ['git', 'network'],
    permissions: ['git:network'],
    idempotent: false,
    input: s.object({
      url: s.string({ description: 'The repository URL to clone.' }),
      directory: s.string({
        description: 'Where to clone it, relative to the workspace root.',
      }),
    }),
    output: runResult,
    examples: [
      {
        description: 'Clone',
        input: { url: 'https://github.com/x/y.git', directory: 'y' },
      },
    ],
    // `--` before the positional arguments so a URL or directory beginning with a
    // dash cannot be read as a git option; and reject remote-helper transport
    // URLs (`ext::…`) that git would execute as a command.
    execute: async ({ url, directory }, ctx) => {
      assertCloneUrlSafe(url);
      return passthrough(await git('clone', ['clone', '--', url, directory], ctx));
    },
  });

  const fetch = defineTool({
    name: 'git.fetch',
    description: 'Fetch from a remote without merging.',
    tags: ['git', 'network'],
    permissions: ['git:network'],
    idempotent: true,
    input: s.object({
      remote: s.withDefault(
        s.string({ description: 'The remote to fetch from.' }),
        'origin',
      ),
    }),
    output: runResult,
    examples: [{ description: 'Fetch origin', input: {} }],
    execute: async ({ remote }, ctx) =>
      passthrough(await git('fetch', ['fetch', remote], ctx)),
  });

  const pull = defineTool({
    name: 'git.pull',
    description: 'Fetch and merge from a remote. A conflict is reported, not thrown.',
    tags: ['git', 'network'],
    permissions: ['git:network'],
    idempotent: false,
    input: s.object({
      remote: s.withDefault(s.string(), 'origin'),
      branch: s.optional(s.string()),
    }),
    output: s.object({
      ok: s.boolean(),
      conflict: s.boolean(),
      stdout: s.string(),
      stderr: s.string(),
    }),
    examples: [{ description: 'Pull', input: {} }],
    execute: async ({ remote, branch: toBranch }, ctx) => {
      const args = ['pull', remote];
      if (toBranch !== undefined) args.push(toBranch);
      const result = await git('pull', args, ctx, { allowFail: true });
      const conflict =
        result.exitCode !== 0 && /conflict/i.test(result.stdout + result.stderr);
      return {
        ok: result.exitCode === 0,
        conflict,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });

  const push = defineTool({
    name: 'git.push',
    description: 'Push commits to a remote. A rejected push is reported with why.',
    tags: ['git', 'network'],
    permissions: ['git:network'],
    idempotent: false,
    input: s.object({
      remote: s.withDefault(s.string(), 'origin'),
      branch: s.optional(s.string()),
      force: s.withDefault(
        s.boolean({ description: 'Force-push (git push --force-with-lease).' }),
        false,
      ),
    }),
    output: s.object({
      ok: s.boolean(),
      rejected: s.boolean(),
      stdout: s.string(),
      stderr: s.string(),
    }),
    examples: [{ description: 'Push', input: {} }],
    execute: async ({ remote, branch: toBranch, force }, ctx) => {
      const args = ['push'];
      // `--force-with-lease`, never a bare `--force`: it refuses to overwrite work
      // the agent has not seen, which is the difference between a force-push that
      // recovers from a rebase and one that silently destroys a colleague's commits.
      if (force) args.push('--force-with-lease');
      args.push(remote);
      if (toBranch !== undefined) args.push(toBranch);
      const result = await git('push', args, ctx, { allowFail: true });
      const rejected =
        result.exitCode !== 0 &&
        /rejected|denied|non-fast-forward/i.test(result.stderr);
      return {
        ok: result.exitCode === 0,
        rejected,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });

  return [
    status,
    log,
    diff,
    branches,
    tags,
    show,
    init,
    add,
    commit,
    checkout,
    branch,
    merge,
    rebase,
    stash,
    tag,
    reset,
    clone,
    fetch,
    pull,
    push,
  ];
}

/** Re-exported so a host can catch it without importing the errors module. */
export { GitError };
