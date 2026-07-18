# @hermes/cli

A deterministic command-line framework — argument parsing, command dispatch, and
injectable IO. `CLI.run` returns an exit code and never touches the process.

- **Design record:** [RFC-0033](../../docs/rfcs/RFC-0033-cli.md).
- **Depends on:** nothing.

## Usage

```ts
import { CLI, runCli } from '@hermes/cli';

const cli = new CLI({
  name: 'hermes',
  version: '1.0.0',
  commands: [
    {
      name: 'plan',
      description: 'Produce a plan for a goal',
      run: ({ args, io }) => {
        if (args.flags.has('v')) io.write('verbose\n');
        io.write(`planning: ${args.positionals.join(' ')}\n`);
        return 0; // exit code
      },
    },
  ],
});

// A bin script — the one impure step:
await runCli(cli); // reads process.argv, sets process.exitCode
```

Testing is a pure call against a buffer — no argv, no stdout, no exit:

```ts
const out: string[] = [];
const code = await cli.run(['plan', '-v', 'ship it'], {
  write: (t) => out.push(t),
  writeError: (t) => out.push(t),
});
// code === 0, out === ['verbose\n', 'planning: ship it\n']
```

## Concepts

- **`parseArgs`.** Schema-less: `positionals`, `options` (`--k v` / `--k=v`),
  and `flags` (`--flag`, `-abc`). `--` ends option parsing.
- **`CLI`.** Routes the first token to a command by name; built-in `help` /
  `--help` / `-h` and `--version`. A command returns a numeric exit code.
- **Deterministic.** `run(argv, io)` returns a code and touches no globals;
  `runCli`/`processIO` (in `node.ts`) are the only process-facing code.
