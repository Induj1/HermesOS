/**
 * The process adapter — the one impure step: read `process.argv`, write to the
 * real streams, and set the exit code. Everything decision-making lives in
 * `CLI.run`, which this simply wires to the process.
 */

import type { CLI, IO } from './cli.js';

/** An `IO` backed by the process streams. */
export function processIO(): IO {
  return {
    write: (text) => {
      process.stdout.write(text);
    },
    writeError: (text) => {
      process.stderr.write(text);
    },
  };
}

/**
 * Run a CLI against the real process: parse `process.argv` (dropping node and
 * the script path), dispatch, and set `process.exitCode` to the result. Sets the
 * code rather than calling `process.exit`, so buffered output flushes.
 */
export async function runCli(
  cli: CLI,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  process.exitCode = await cli.run(argv, processIO());
}
