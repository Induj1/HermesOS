/**
 * The CLI — dispatch a command from argv, with injected IO and an exit code.
 *
 * Determinism is the whole point: `run` takes the argument list and an `IO`
 * sink and *returns* an exit code — it never reads `process.argv`, writes to a
 * real stream, or calls `process.exit`. That makes an end-to-end CLI test a pure
 * function call against a buffer, and leaves the one impure step (wiring to the
 * process) to a thin adapter in `node.ts`.
 *
 * A `Command` owns its own argument parsing (via `parseArgs`) so each command's
 * flags are its business; the CLI only routes to it by name and supplies the
 * built-in `help` and `--version`.
 */

import { parseArgs, type ParsedArgs } from './args.js';

/** Where a command's output goes. Injected, so tests capture it. */
export interface IO {
  write(text: string): void;
  writeError(text: string): void;
}

export interface CommandContext {
  /** The parsed arguments *after* the command name. */
  readonly args: ParsedArgs;
  /** The raw argument tokens after the command name. */
  readonly argv: readonly string[];
  readonly io: IO;
}

export interface Command {
  readonly name: string;
  readonly description: string;
  /** Run the command; return a process exit code (0 = success). */
  run(context: CommandContext): Promise<number> | number;
}

export interface CliOptions {
  readonly name: string;
  readonly version?: string;
  readonly commands?: readonly Command[];
}

export class CLI {
  readonly #name: string;
  readonly #version: string;
  readonly #commands = new Map<string, Command>();

  constructor(options: CliOptions) {
    this.#name = options.name;
    this.#version = options.version ?? '0.0.0';
    for (const command of options.commands ?? []) this.add(command);
  }

  /** Register a command. A duplicate name throws — that is a wiring bug. */
  add(command: Command): this {
    if (this.#commands.has(command.name)) {
      throw new Error(`command "${command.name}" is already registered`);
    }
    this.#commands.set(command.name, command);
    return this;
  }

  /**
   * Dispatch. The first token is the command name; the rest are the command's.
   * `help`/`--help`/`-h` print usage (exit 0); `--version` prints the version
   * (exit 0); an empty invocation prints usage (exit 1, since nothing ran); an
   * unknown command prints an error and usage (exit 1).
   */
  async run(argv: readonly string[], io: IO): Promise<number> {
    const [first, ...rest] = argv;

    if (first === undefined) {
      this.#printUsage(io);
      return 1;
    }
    if (first === '--version') {
      io.write(`${this.#version}\n`);
      return 0;
    }
    if (first === 'help' || first === '--help' || first === '-h') {
      this.#printUsage(io);
      return 0;
    }

    const command = this.#commands.get(first);
    if (command === undefined) {
      io.writeError(`unknown command: ${first}\n`);
      this.#printUsage(io);
      return 1;
    }

    return command.run({ args: parseArgs(rest), argv: rest, io });
  }

  #printUsage(io: IO): void {
    const lines = [`${this.#name} <command> [options]`, '', 'Commands:'];
    const width = Math.max(4, ...[...this.#commands.keys()].map((n) => n.length));
    for (const command of this.#commands.values()) {
      lines.push(`  ${command.name.padEnd(width)}  ${command.description}`);
    }
    lines.push(`  ${'help'.padEnd(width)}  Show this help`);
    io.write(`${lines.join('\n')}\n`);
  }
}
