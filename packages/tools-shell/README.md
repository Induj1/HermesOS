# @hermes/tools-shell

Run commands for an agent — safely enough to hand a language model.

- **Design record:** [RFC-0008](../../docs/rfcs/RFC-0008-shell-tools.md).
- **Depends on:** `@hermes/tools`, `@hermes/kernel`. `node:child_process` in one
  file only.

## The two decisions that make it safe

Running commands is the most dangerous thing an agent can do, and a model's
command may be steered by a prompt-injected document. Two decisions carry the
weight:

- **Argv, never a shell string.** `shell.run` takes a program and an array of
  arguments, and the process is spawned with `shell: false`. There is no command
  string for a shell to parse, so injection is not mitigated — it is
  **unrepresentable**. An argument `; rm -rf ~` is a literal argument, not a
  second command.
- **An allowlist, never "any command".** `shell:exec` permission is not enough;
  the toolset requires an explicit list of _which_ programs may run. Default
  deny.

## Usage

```ts
import { shellToolset, NodeShellExecutor } from '@hermes/tools-shell';
import { PermissionSet } from '@hermes/tools';

runtime.use(
  shellToolset({
    executor: new NodeShellExecutor({ cwd: '/srv/workspace' }),
    allow: ['git', 'ls', 'cat'], // required — the security decision
    granted: PermissionSet.none().grant('shell:exec'), // opt in explicitly
  }),
);
```

`allow` is required and has no "everything" shortcut. `granted` defaults to
nothing, because there is no safe subset of "run commands" the way there is of
"touch files".

## `shell.run`

```ts
// { command, args, stdin?, timeoutMs? } → { exitCode?, stdout, stderr, timedOut, truncated }
{ command: 'git', args: ['commit', '-m', 'a message; with metacharacters'] }
```

Each argument is passed literally — metacharacters and all. A **non-zero exit is
a normal result**, not an error, so an agent can reason about a failed command.
The tool throws only when the command could not be run (not allowed, not found).

Every run is bounded: a timeout (default 30 s), an output cap (default 1 MiB,
sets `truncated`), a minimal `{ PATH }` environment (never the host's secrets),
and cancellation via the kernel's signal. A model may _shorten_ the timeout,
never lengthen it past the host's guard.

## Testing your own tools against a shell

`FakeShellExecutor` runs no process and answers from a handler, so a test can
assert on exactly what a tool sent:

```ts
import {
  FakeShellExecutor,
  shellTools,
  allowlisted,
} from '@hermes/tools-shell';
import { callTool } from '@hermes/tools';

const exec = new FakeShellExecutor({
  handle: () => ({ stdout: 'on main', exitCode: 0 }),
});
const [run] = shellTools(allowlisted(exec, ['git']));

expect(await callTool(run, { command: 'git', args: ['status'] })).toMatchObject(
  {
    stdout: 'on main',
  },
);
expect(exec.runs[0]?.args).toEqual(['status']); // exactly what was sent
```

## Public API

| Export                         | What it is                                        |
| ------------------------------ | ------------------------------------------------- |
| `shellToolset`                 | The one call a host makes. Requires an allowlist. |
| `shellTools`                   | The `shell.run` tool over an injected executor.   |
| `ShellExecutor`, `allowlisted` | The port, and the allowlist wrapper.              |
| `NodeShellExecutor`            | Real, `spawn` with `shell: false`.                |
| `FakeShellExecutor`            | Scripted, spawns nothing. Tests and canned menus. |
| `ShellError`, `fromSpawnError` | Structured "could not run" errors.                |

## Tests

```sh
pnpm test           # 46 tests, incl. a real-process suite proving argv is not a shell
pnpm test:coverage  # enforces a 95% threshold
```
