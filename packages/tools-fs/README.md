# @hermes/tools-fs

Filesystem tools for Hermes — read, write, list, and move files, safely enough
to hand a language model.

- **Design record:** [RFC-0007](../../docs/rfcs/RFC-0007-filesystem-tools.md).
- **Depends on:** `@hermes/tools`, `@hermes/kernel`. `node:fs` in one file only.

## Why it is more than a wrapper around `node:fs`

The `path` comes **from a model**, and a model asked to read "the config" may
decide the config is at `../../etc/shadow`. Two things make that safe:

- **A port, not `node:fs`.** Every tool talks to a `FileSystem` interface, so
  the whole suite tests against an in-memory filesystem with no disk, and a host
  can swap the backing store. `node:fs` lives in one file, `NodeFileSystem`.
- **A root, not raw paths.** `rooted(fs, root)` confines every path and refuses
  escapes — `../../etc/shadow` is stopped before the filesystem is touched.
  Containment is one small, exhaustively tested pure function.

## Usage

```ts
import { filesystemToolset, NodeFileSystem } from '@hermes/tools-fs';
import { PermissionSet } from '@hermes/tools';

runtime.use(
  filesystemToolset({
    fs: new NodeFileSystem(),
    root: '/srv/hermes/workspace', // paths cannot escape this
    granted: PermissionSet.none().grant('fs:read'), // read-only by default
  }),
);
```

With that grant, `fs.read`/`fs.list`/`fs.stat`/`fs.exists` work and the write
tools (`fs.write`, `fs.mkdir`, `fs.remove`, `fs.move`) register but refuse — so
a model is told they exist and learns it may not use them, rather than finding
them mysteriously absent.

## The tools

| Tool        | Does                            | Permission |
| ----------- | ------------------------------- | ---------- |
| `fs.read`   | Read a UTF-8 text file (capped) | `fs:read`  |
| `fs.list`   | List a directory's entries      | `fs:read`  |
| `fs.stat`   | Type, size, modification time   | `fs:read`  |
| `fs.exists` | Check existence (fails closed)  | `fs:read`  |
| `fs.write`  | Write a UTF-8 text file         | `fs:write` |
| `fs.mkdir`  | Create a directory and parents  | `fs:write` |
| `fs.remove` | Delete a file or tree           | `fs:write` |
| `fs.move`   | Move or rename                  | `fs:write` |

`fs.read` returns text or a `NOT_TEXT` error — never the mojibake of a decoded
binary. Large files are refused with `TOO_LARGE` (checked from `stat` before the
read, so nothing oversized is loaded).

## Testing your own tools against a filesystem

`MemoryFileSystem` is a real, rule-enforcing filesystem, ideal for tests:

```ts
import { MemoryFileSystem, filesystemTools } from '@hermes/tools-fs';
import { callTool } from '@hermes/tools';

const fs = MemoryFileSystem.withFiles({ '/config.json': '{}' });
const [read] = filesystemTools(fs);

expect(await callTool(read, { path: 'config.json' })).toBe('{}');
```

It is also useful in production: an empty `MemoryFileSystem` is a sandbox a
model genuinely cannot escape, because there is no disk under it.

## Public API

| Export                             | What it is                                      |
| ---------------------------------- | ----------------------------------------------- |
| `filesystemToolset`                | The one call a host makes. Returns a plugin.    |
| `filesystemTools`                  | The tools, over an injected filesystem.         |
| `FileSystem`                       | The port. Seven cancellable methods.            |
| `NodeFileSystem`                   | Real, backed by `node:fs`.                      |
| `MemoryFileSystem`                 | In-memory, rule-enforcing. Tests and sandboxes. |
| `rooted`, `resolveWithin`          | Containment. `resolveWithin` is pure.           |
| `FileSystemError`, `fromNodeError` | Structured errors with a stable `code`.         |

## Tests

```sh
pnpm test           # 104 tests, incl. a real-disk NodeFileSystem suite
pnpm test:coverage  # enforces a 95% threshold
```
