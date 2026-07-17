/**
 * The shell tools.
 *
 * One tool: `shell.run`. There is deliberately no `shell.exec("a | b > c")` that
 * takes a command line, because a command line is a string a shell interprets,
 * and this package exists to never do that (see `executor.ts`). Piping and
 * redirection are a host's job to compose out of allow-listed programs, not a
 * model's to request as text. (A `shell.which` availability check is future work
 * — see RFC-0008 §7.1 — and is left out rather than faked by running the command.)
 *
 * ## What the model sends, and does not
 *
 * `shell.run` takes `{ command, args }` — a program name and an array. The array
 * is the point: each element is one argument, passed to the process untouched, so
 * a model cannot smuggle a second command through an argument. The schema makes
 * that shape the *only* shape a model can express.
 */

import { defineTool, s, type HermesTool } from '@hermes/tools';
import type { ShellExecutor } from './executor.js';

export interface ShellToolsOptions {
  /** Default timeout for a run that does not set one, in ms. */
  readonly timeoutMs?: number;
  /** Default working directory, shown to the model in the description. */
  readonly cwd?: string;
}

/**
 * Build the shell tools over an injected executor.
 *
 * The executor is where the allowlist lives ({@link allowlisted}) and where the
 * process is spawned ({@link NodeShellExecutor}). The tools are a thin, validated
 * surface over it — which is why they are testable against a `FakeShellExecutor`
 * with no process in sight.
 */
export function shellTools(
  executor: ShellExecutor,
  options: ShellToolsOptions = {},
): readonly HermesTool[] {
  const run = defineTool({
    name: 'shell.run',
    description:
      'Run a command with the given arguments and return its output and exit code. ' +
      'The command is run directly, not through a shell: there is no piping, ' +
      'redirection, or variable expansion, and each argument is passed literally. ' +
      'A non-zero exit code is a normal result, not an error.',
    tags: ['shell', 'exec'],
    permissions: ['shell:exec'],
    // Not idempotent: running a command twice is running it twice. Whether that
    // is safe is the command's business, and the caller's to know (RFC-0004 §7.3).
    idempotent: false,
    input: s.object({
      command: s.string({
        description: 'The program to run, e.g. "git". Not a command line.',
      }),
      args: s.withDefault(
        s.array(s.string(), {
          description: 'Arguments, one per element. Passed literally.',
        }),
        [],
      ),
      stdin: s.optional(
        s.string({ description: 'Text to pipe to the command on stdin.' }),
      ),
      timeoutMs: s.optional(
        s.number({
          integer: true,
          minimum: 1,
          description: 'Kill the command after this long.',
        }),
      ),
    }),
    output: s.object({
      exitCode: s.optional(s.number({ integer: true })),
      stdout: s.string(),
      stderr: s.string(),
      timedOut: s.boolean(),
      truncated: s.boolean(),
    }),
    examples: [
      { description: 'List a directory', input: { command: 'ls', args: ['-la'] } },
      {
        description: 'Check the git status',
        input: { command: 'git', args: ['status', '--short'] },
      },
    ],
    execute: async ({ command, args, stdin, timeoutMs }, ctx) => {
      // A model-supplied timeout may only *shorten* the host's, never lengthen
      // it: the host's is a safety limit, and a model raising it past a runaway
      // guard would defeat the guard.
      const timeout = cappedTimeout(timeoutMs, options.timeoutMs);
      const result = await executor.run(command, args, {
        ...(stdin === undefined ? {} : { stdin }),
        // The working directory is the *host's* choice, not the model's: a `cwd`
        // taken from the model would let it run a command anywhere on the disk,
        // which is the containment the filesystem tools take such care over,
        // thrown away at the shell. It is fixed here at wiring.
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        signal: ctx.signal,
      });
      return {
        // `exitCode: undefined` when the process was killed (timeout/signal),
        // where `null` from the port becomes an absent field the model reads as
        // "no clean exit" — which the accompanying `timedOut` explains.
        exitCode: result.exitCode ?? undefined,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    },
  });

  return [run];
}

/**
 * The timeout a run should use, given a model's request and the host's limit.
 *
 * The model may ask for less and never more. Absent a host limit, a model's
 * request stands (there is no guard to defeat); absent a model request, the
 * host's limit applies; with both, the smaller wins. `undefined` means "the
 * executor's own default", which is the safe fallback when neither was set.
 */
function cappedTimeout(
  requested: number | undefined,
  hostLimit: number | undefined,
): number | undefined {
  if (requested === undefined) return hostLimit;
  if (hostLimit === undefined) return requested;
  return Math.min(requested, hostLimit);
}
