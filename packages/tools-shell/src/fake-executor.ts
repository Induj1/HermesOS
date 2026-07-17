/**
 * A scripted executor — the default for tests, and a real implementation.
 *
 * Runs no process. It answers from a handler a test provides, so the tools above
 * can be exercised deterministically with no `git` on the PATH, no timing races,
 * and no cleanup. It is a real `ShellExecutor`, so a tool that passes against it
 * is exercising the same code path it would with `NodeShellExecutor` — only the
 * process at the far end is simulated.
 *
 * It is also useful beyond tests: a host that wants to expose a *fixed* set of
 * canned operations to an agent (a menu of safe, pre-approved commands) can back
 * the shell tools with one of these and never spawn anything at all.
 */

import type { ShellExecutor, ShellResult, ShellRunOptions } from './executor.js';

/** What a handler returns: the parts of a result it cares to set. The rest default. */
export type FakeResult = Partial<Omit<ShellResult, 'command' | 'args'>>;

export type FakeHandler = (
  command: string,
  args: readonly string[],
  options: ShellRunOptions,
) => FakeResult | Promise<FakeResult>;

export interface FakeShellExecutorOptions {
  /**
   * Decide the outcome of each run.
   *
   * A function rather than a static map, because the interesting shell tests are
   * about *what a tool sends* — the exact argv, the cwd, the stdin — and a
   * handler can assert on all of it. A handler that throws simulates a command
   * that could not be run (the executor's `NOT_FOUND`/`NOT_ALLOWED` contract).
   */
  readonly handle: FakeHandler;
}

export class FakeShellExecutor implements ShellExecutor {
  /** Every run it received, in order, for a test to assert on afterwards. */
  readonly runs: {
    command: string;
    args: readonly string[];
    options: ShellRunOptions;
  }[] = [];
  readonly #handle: FakeHandler;

  constructor(options: FakeShellExecutorOptions) {
    this.#handle = options.handle;
  }

  /** A fixed successful result for any command — the simplest useful fake. */
  static succeedingWith(stdout: string): FakeShellExecutor {
    return new FakeShellExecutor({ handle: () => ({ stdout, exitCode: 0 }) });
  }

  async run(
    command: string,
    args: readonly string[],
    options: ShellRunOptions = {},
  ): Promise<ShellResult> {
    this.runs.push({ command, args, options });
    options.signal?.throwIfAborted();

    const partial = await this.#handle(command, args, options);
    return {
      command,
      args: [...args],
      // An explicit `null` means "killed, no clean exit" and must survive; an
      // omitted field defaults to a clean `0`. A bare `?? 0` would conflate the
      // two, reporting a killed process as a success — the case a timeout test
      // needs to tell apart. The `in` check is what keeps `null` from collapsing.
      exitCode: partial.exitCode ?? ('exitCode' in partial ? null : 0),
      signal: partial.signal ?? null,
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      timedOut: partial.timedOut ?? false,
      truncated: partial.truncated ?? false,
      durationMs: partial.durationMs ?? 0,
    };
  }
}
