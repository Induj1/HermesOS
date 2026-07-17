# RFC-0010: Git Tools

| Field         | Value                                                                              |
| ------------- | ---------------------------------------------------------------------------------- |
| Status        | Implemented                                                                        |
| Date          | 2026-07-17                                                                         |
| Scope         | `packages/tools-git` (`@hermes/tools-git`)                                         |
| Depends on    | RFC-0001 (kernel), RFC-0006 (tool framework), RFC-0007 (pattern), RFC-0008 (shell) |
| Supersedes    | —                                                                                  |
| Superseded by | —                                                                                  |

Design record for the git tools. Unlike the shell and HTTP packages, this one is
less a security document — it borrows its security wholesale from the shell
package — and more a document about **reuse** and about **what an expected git
failure is**. It follows the tool-package pattern (a port, one platform-coupled
implementation, a fake) and the interesting parts are the wrapping of the shell
executor and the read-tool parsers.

Covered by 106 tests in `packages/tools-git/tests`.

---

## 1. Context

An autonomous engineer's most-used tool is git. It needs to inspect history,
stage and commit work, branch and merge, and sync with a remote. So the tools
here span the full local lifecycle — status, add, commit, log, diff, branch,
checkout, merge, rebase, stash, tag, reset — plus the network four — clone,
fetch, pull, push.

The obvious way to build this is to reach for `child_process` and spawn `git`.
That is a mistake, because "spawn a program safely" is a hard,
security-sensitive problem the shell package (RFC-0008) already solved once:
argv-not-a-shell (so injection is unrepresentable), a timeout, an output cap, an
isolated environment, and cooperative cancellation. Re-solving it here would be
duplicating the most dangerous code in the tool layer, and every future fix to
it would have to be made twice.

## 2. The organising principle

> **Running git is running a command. So the git executor _is_ a shell executor,
> pinned to one program in one place — and expected git failures are results,
> not errors.**

Two ideas, and everything below follows from them.

The first is reuse. `ShellGitExecutor` holds a `ShellExecutor` and calls it with
the program fixed to `git` and the `cwd` fixed under a confined root. It adds
nothing to the process-spawning machinery; it _subtracts_ freedom from it. The
recommended wiring hands it an `allowlisted(shell, ['git'])`, so even this
narrow wrapper cannot be talked into running anything but git.

The second is the failure model, inherited from the kernel's error convention
(RFC-0001 §5) and the tool framework: a `git` command that _ran and failed_ — a
merge conflict, a rejected push, an empty commit — is not a thrown error. It is
a structured outcome the tool returns, so an agent can reason about it and act
(a conflict can be resolved; an exit code cannot). A `GitError` is thrown only
when git could not run at all, or the framework refused it.

## 3. The executor port

```ts
interface GitExecutor {
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}
```

`args` is an argv array passed to git untouched — a branch named `; rm -rf ~` is
a branch name, not a second command, because the shell executor underneath never
sees a command line. `GitResult` carries git's `exitCode`, `stdout`, `stderr`,
and `timedOut` faithfully; the tools interpret them.

Two implementations ship:

- **`ShellGitExecutor`** — the real one, over a `ShellExecutor`. Confines the
  `cwd` to a root (see §7), pins the program to `git` (or an absolute
  `gitPath`), and threads timeout and signal through.
- **`FakeGitExecutor`** — a scripted double that runs no git. It answers from a
  handler keyed on the argv, so the tools and their parsers are exercised
  against exact, crafted git output without a repository in a known state (real
  git embeds hashes and dates, which makes assertions fragile). The
  real-repository behaviour is proven separately, against actual git, in
  `integration.test.ts`.

## 4. Permissions: three grades

Git operations are not uniform in risk, so they are split across three
permissions rather than one:

| Permission    | Tools                                                                 | Reach                                    |
| ------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `git:read`    | status, log, diff, branches, tags, show                               | Inspect history; change nothing          |
| `git:write`   | init, add, commit, checkout, branch, merge, rebase, stash, tag, reset | Change the working tree or local history |
| `git:network` | clone, fetch, pull, push                                              | Talk to a remote                         |

The toolset defaults to **`git:read` only** — mirroring the filesystem toolset
(read by default), not the shell toolset (nothing by default), because git has a
genuinely safe read-only subset worth offering out of the box. A host escalates
explicitly: `.grant('git:write')`, then `.grant('git:network')`. Those grants,
next to the executor's allowlist, are the whole audit trail of what an agent may
do to a repository.

## 5. Structured reads, honest writes

The read tools return **structured** output, parsed from git's _stable_
machine-readable formats — `status --porcelain=v1`, a `log --format` with
control-character separators, `branch --list`. A model reasons about
`{ state: 'staged', path: 'a.ts' }`, not a two-character porcelain code it has
to decode. Crucially, the tools never scrape git's human-facing prose, which git
is free to reword between versions; the porcelain formats are a documented
contract.

The `--format` separators are the ASCII unit- and record-separator control
characters (`\x1f`, `\x1e`), not a printable delimiter, so a commit subject
containing `|` — or anything a human can type — cannot break the parse.

The write and network tools return git's own exit code and output, because git's
messages are what a human expects to see. The three tools whose _expected_
failure is a normal outcome — merge, rebase, pull (conflict) and push
(rejection) — run with `allowFail` and report `{ conflict: true }` or
`{ rejected: true }` as data instead of throwing.

## 6. Safety details worth stating

- **`--` before positional arguments.** `add`, `diff --path`, and `clone` place
  a `--` before user-controlled paths and URLs, so a value beginning with a dash
  cannot be reinterpreted as a git option.
- **`--force-with-lease`, never `--force`.** `push --force` uses
  `--force-with-lease`, which refuses to overwrite commits the agent has not
  seen. That is the difference between a force-push that recovers from a local
  rebase and one that silently destroys a collaborator's work.
- **Failure classification reads both streams.** git is inconsistent about which
  stream it uses — a rejected push writes to stderr, but "nothing to commit"
  goes to stdout — so `classifyGitFailure` inspects both. The carried
  `GitError.stderr` is still only stderr, what a human debugs with; the
  _classification_ looks at everything git said. The classifier is deliberately
  conservative: an unrecognised failure is `GIT_FAILED` with the raw output
  attached, never a wrong guess, and the code is a hint on top of the always-
  available exit code and text.

## 7. On duplicating `confine`

`ShellGitExecutor` confines its `cwd` to a root with a small pure function,
`confine(root, path)` — the same POSIX-style path containment the filesystem
tools use (RFC-0007 §4): resolve `.` and `..` against the root, refuse anything
that climbs above it, and do it as a function of two strings so there is no disk
access and thus no TOCTOU gap between the check and the use.

This is a near-duplicate of the filesystem package's `resolveWithin`, and that
is a deliberate choice, recorded here so it is not mistaken for an oversight.
Tying `@hermes/tools-git` to `@hermes/tools-fs` for one twenty-line function
would be a worse coupling than the duplication: it would drag the whole
filesystem _tools_ package — its ports, its Node and memory implementations, its
permissions — into the dependency graph of every consumer of git, to reuse a
string helper.

The rule of three applies. Two consumers is a coincidence; three is a pattern
that earns a shared home. If a third confinement consumer appears, the function
graduates to a small shared utility (a `@hermes/paths` or similar) and both call
sites move to it. Until then, the duplication stays, small and tested on both
sides.

## 8. What is not here

- **No arbitrary-flag passthrough.** Each tool exposes a curated set of options,
  not a `flags: string[]`. A model that could pass any flag could pass
  `--upload-pack` to `fetch` (arbitrary command execution on some transports),
  or `-c core.fsmonitor=...`. The curated surface is the point; a genuinely
  needed flag is added deliberately.
- **No credential management.** Authentication to a remote is the host's
  business — a credential helper, an SSH agent, an ambient token. The tools
  surface an `AUTH_FAILED` when it is missing and otherwise stay out of it. Live
  push/pull against a real remote is therefore the one thing these tests do not
  cover; it needs a credentialed remote, and is called out in STATUS.md.
- **No submodule, worktree, or bisect tools.** The lifecycle above is what an
  autonomous engineer needs first. These are extensions, not omissions, and slot
  into the same pattern when a consumer needs them.

## 9. Testing

- **Unit, fake-driven** (`parse`, `errors`, `executor`, `fake-executor`,
  `tools`, `toolset`) — the argv each tool sends, the structured result it
  returns, the error each failure classifies to, confinement, and permission
  enforcement through a real `Runtime`.
- **Integration, real git** (`integration.test.ts`) — the full local flow (init
  → config → add → commit → log → branch → checkout → diff → tag → merge)
  against actual `git` in a throwaway repository, plus a real merge conflict
  reported as data and a real `PATH_ESCAPE` refusal. This is what proves the
  porcelain the parsers expect is the porcelain git emits.

Branch coverage is 98.7%, above the enforced 95% floor.

## 10. Known limitations

- **Live remote operations are unverified.** clone/fetch/pull/push are
  implemented and unit-tested against the fake, but not exercised against a real
  authenticated remote, because that needs a credential the build does not have.
  The argv and result-shaping are covered; the network round-trip is not.
- **`confine` is duplicated** with `@hermes/tools-fs` (§7), by choice, until a
  third consumer justifies extracting it.
- **Failure classification is best-effort** (§6). It keys on git's human-facing
  message strings, which can change between versions; the exit code and raw
  output are always carried so a caller need not trust the code.
