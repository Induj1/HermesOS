# RFC-0033: CLI

| Field         | Value                          |
| ------------- | ------------------------------ |
| Status        | Implemented                    |
| Date          | 2026-07-18                     |
| Scope         | `packages/cli` (`@hermes/cli`) |
| Depends on    | — (zero dependencies)          |
| Supersedes    | —                              |
| Superseded by | —                              |

Design record for the command-line framework: argument parsing, command
dispatch, and injectable IO.

Covered by 22 tests in `packages/cli/tests`.

---

## 1. Context

A CLI is one of the interfaces to Hermes, alongside the REST API (#24). It is
also, historically, the hardest kind of code to test — it reads `process.argv`,
writes to `stdout`, and calls `process.exit`, all global side effects. This
package removes every one of those from the core: `CLI.run(argv, io)` takes the
argument list and an `IO` sink and **returns an exit code**. An end-to-end CLI
test is then a pure function call against a buffer, and the one impure step —
wiring to the process — is a five-line adapter in `node.ts`.

Zero dependencies. Argument parsing and dispatch are small enough that a parser
library (and its option-schema DSL) would be more surface than the thing it
replaces.

## 2. Argument parsing

`parseArgs(tokens)` sorts tokens into `positionals`, `options` (`--key value` /
`--key=value`), and boolean `flags` (`--flag`, `-abc`). It is **schema-less**:
it does not know which options a command expects, so a command reads what it
needs from the parsed structure. The rules are chosen to be unsurprising and
stateless:

- `--` ends option parsing; the rest are positionals (so a `-`-leading path can
  still be passed).
- `--key=value` is always an option.
- `--key value` is an option unless the next token is itself an option (or
  absent), in which case `--key` is a boolean flag.
- `-abc` is three short flags; single-dash tokens never take a value, so short
  and long forms do not have subtly different rules.

The one genuine ambiguity of a schema-less parser — a boolean flag immediately
followed by a positional — is resolved by the documented "consumes the next
token unless it looks like an option" rule, and `--flag` before another option
or `--` is always unambiguous.

## 3. Dispatch

`CLI` routes the first token to a registered `Command` by name and hands the
command the remaining tokens (both raw `argv` and the `parseArgs` result), so
each command owns its own flags. It supplies three built-ins: `help` / `--help`
/ `-h` print usage (exit 0), `--version` prints the version (exit 0), and an
empty invocation prints usage but exits **1** (nothing ran). An unknown command
prints an error to `stderr`, usage to `stdout`, and exits 1. A duplicate command
registration throws at construction — a wiring bug, caught early.

A `Command` returns a **numeric exit code**; the CLI propagates it unchanged, so
a failing command (`return 2`) surfaces as a real process exit status.

## 4. The process boundary

`node.ts` holds the only impure code: `processIO()` routes `write`→stdout and
`writeError`→stderr, and `runCli(cli, argv?)` parses `process.argv.slice(2)`
(overridable, which is what makes it testable), dispatches, and sets
**`process.exitCode`** — deliberately not `process.exit`, so buffered output
flushes before the process ends.

## 5. Non-goals

- **No option schema / validation.** Commands validate their own arguments. A
  typed-flags helper can layer on top of `parseArgs` without changing it.
- **No interactive prompts, colours, or spinners.** Those are presentation an
  application adds; the framework stays a pure dispatcher over an `IO` sink.
- **No subcommand trees.** One level of command routing; a command that wants
  subcommands can call `parseArgs`/route on its own positionals.

## 6. Testing

22 tests: `parseArgs` across positionals, both option forms, flag
disambiguation, short-flag expansion, the `--` terminator, a lone `-`, and empty
input; `CLI` dispatch and exit-code propagation, argument threading, the
`help`/`--help`/`-h`/ `--version` built-ins and version default, the empty and
unknown-command paths, duplicate-registration throw, and incremental `add`; and
the `node` adapter's stream routing and `process.exitCode`/`argv` wiring. 100%
branch coverage.
