/**
 * @hermes/cli — A deterministic command-line framework.
 *
 * ```ts
 * const cli = new CLI({
 *   name: 'hermes',
 *   version: '1.0.0',
 *   commands: [
 *     {
 *       name: 'plan',
 *       description: 'Produce a plan for a goal',
 *       run: ({ args, io }) => {
 *         io.write(`planning: ${args.positionals.join(' ')}\n`);
 *         return 0;
 *       },
 *     },
 *   ],
 * });
 *
 * // In a bin script:
 * await runCli(cli); // reads process.argv, sets process.exitCode
 *
 * // In a test — a pure call against a buffer:
 * const out: string[] = [];
 * const code = await cli.run(['plan', 'ship it'], {
 *   write: (t) => out.push(t),
 *   writeError: (t) => out.push(t),
 * });
 * ```
 *
 * `CLI.run` returns an exit code and never touches the process; `runCli` is the
 * one adapter that wires it to `process.argv`/streams/`exitCode`.
 */

export { parseArgs, type ParsedArgs } from './args.js';

export {
  CLI,
  type CliOptions,
  type Command,
  type CommandContext,
  type IO,
} from './cli.js';

export { processIO, runCli } from './node.js';
