/**
 * A scripted git executor — the default for tests, and a real implementation.
 *
 * Runs no `git`. It answers from a handler keyed on the subcommand and args, so
 * the tools and their output parsers can be exercised against exact, crafted git
 * output — porcelain status, `--format` log lines, a merge-conflict stderr —
 * without a real repository in a known state, which is slow to set up and hard to
 * make deterministic (real git embeds hashes and dates).
 *
 * The real-repository behaviour is covered separately, in `integration.test.ts`,
 * against actual `git`. The two together are the pattern: the fake proves the
 * parsing, the real one proves the parsing matches what git actually emits.
 */

import type { GitExecutor, GitResult, GitRunOptions } from './executor.js';

export type FakeGitResult = Partial<Omit<GitResult, 'args'>>;

export type FakeGitHandler = (
  args: readonly string[],
  options: GitRunOptions,
) => FakeGitResult | Promise<FakeGitResult>;

export interface FakeGitExecutorOptions {
  readonly handle: FakeGitHandler;
}

export class FakeGitExecutor implements GitExecutor {
  /** Every invocation, in order, for a test to assert the exact argv sent to git. */
  readonly runs: { args: readonly string[]; options: GitRunOptions }[] = [];
  readonly #handle: FakeGitHandler;

  constructor(options: FakeGitExecutorOptions) {
    this.#handle = options.handle;
  }

  /** Always succeeds with the given stdout — the simplest useful fake. */
  static succeedingWith(stdout: string): FakeGitExecutor {
    return new FakeGitExecutor({ handle: () => ({ stdout, exitCode: 0 }) });
  }

  /** Fails with the given stderr and exit code — for testing error classification. */
  static failingWith(stderr: string, exitCode = 1): FakeGitExecutor {
    return new FakeGitExecutor({ handle: () => ({ stderr, exitCode }) });
  }

  async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    this.runs.push({ args, options });
    options.signal?.throwIfAborted();

    const partial = await this.#handle(args, options);
    return {
      args: [...args],
      // `in`, not `??`: an explicit `exitCode: null` (killed) must survive rather
      // than collapse to 0 — the same care the shell fake takes.
      exitCode: partial.exitCode ?? ('exitCode' in partial ? null : 0),
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      timedOut: partial.timedOut ?? false,
    };
  }
}
