# @hermes/tools-git

Drive `git` from an agent, within bounds.

- **Design record:** [RFC-0010](../../docs/rfcs/RFC-0010-git-tools.md).
- **Depends on:** `@hermes/tools`, `@hermes/kernel`, and `@hermes/tools-shell` —
  from which it borrows all of its process-spawning safety.

## The two ideas

- **Running git is running a command.** So the git executor _is_ a shell
  executor (`@hermes/tools-shell`), pinned to `git` in a confined repository
  root. It inherits argv-not-a-shell (injection is unrepresentable), timeouts,
  output caps, an isolated environment, and cancellation for free — and every
  future fix to the shell layer with it. A branch named `; rm -rf ~` is a branch
  name, not a second command.
- **Expected git failures are results, not errors.** A merge conflict, a
  rejected push, an empty commit — these are structured outcomes the tools
  return, so an agent can reason about them and act. A `GitError` is thrown only
  when git could not run at all (not installed, cwd escaped the root).

## Usage

```ts
import { gitToolset, ShellGitExecutor } from '@hermes/tools-git';
import { NodeShellExecutor, allowlisted } from '@hermes/tools-shell';
import { PermissionSet } from '@hermes/tools';

const shell = allowlisted(new NodeShellExecutor(), ['git']);

runtime.use(
  gitToolset({
    executor: new ShellGitExecutor(shell, { root: '/srv/workspace' }),
    granted: PermissionSet.none().grant('git:read').grant('git:write'),
  }),
);
```

`granted` defaults to **read-only** (`git:read`). Grant `git:write` for local
history changes and `git:network` for remote sync — each an explicit, auditable
escalation.

## The tools

| Permission    | Tools                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `git:read`    | `git.status` `git.log` `git.diff` `git.branches` `git.tags` `git.show`                                                   |
| `git:write`   | `git.init` `git.add` `git.commit` `git.checkout` `git.branch` `git.merge` `git.rebase` `git.stash` `git.tag` `git.reset` |
| `git:network` | `git.clone` `git.fetch` `git.pull` `git.push`                                                                            |

The read tools return **structured** output parsed from git's stable porcelain
formats — a model reasons about `{ state: 'staged', path: 'a.ts' }`, never a
scraped two-character code. The rest carry git's own exit code and messages.

```ts
// git.status → { branch, ahead, behind, clean, entries: [{ path, state, code }] }
// git.log    → [{ hash, author, email, date, subject }]
// git.merge  → { merged, conflict, stdout, stderr }   // a conflict is data, not a throw
// git.push   → { ok, rejected, stdout, stderr }        // --force uses --force-with-lease
```

## Safety notes

- **`--` guards.** `add`, `diff --path`, and `clone` place a `--` before
  user-controlled paths and URLs, so a leading dash cannot become a git option.
- **`--force-with-lease`, never `--force`** on push — it refuses to overwrite
  commits the agent has not seen.
- **Repository confinement.** Every operation runs under a root; a `cwd` that
  escapes it is refused with `PATH_ESCAPE` before git is spawned.
- **No arbitrary flags.** Each tool exposes a curated option set, not a
  `flags: string[]`. See RFC-0010 §8.

## Testing against a fake

`FakeGitExecutor` runs no git and answers from a handler keyed on the argv, so
you can exercise tools against exact, crafted git output:

```ts
import { gitTools, FakeGitExecutor } from '@hermes/tools-git';
import { callTool } from '@hermes/tools';

const git = FakeGitExecutor.succeedingWith('## main\n M src/a.ts\n');
const [status] = gitTools(git).filter((t) => t.name === 'git.status');
await callTool(status!, {}); // → { branch: 'main', clean: false, entries: [...] }
```

The real-git behaviour is proven separately, against actual `git`, in
`tests/integration.test.ts`.

## What needs a credential

`clone`/`fetch`/`pull`/`push` are implemented and unit-tested against the fake,
but a live round-trip to an authenticated remote is not covered here — that
needs a credential the build does not have. See RFC-0010 §10 and STATUS.md.
