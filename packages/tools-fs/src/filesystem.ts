/**
 * The filesystem port — the seam that makes these tools testable and safe.
 *
 * ## Why the tools do not call `node:fs` directly
 *
 * Two reasons, and both are load-bearing.
 *
 * **Testability.** A tool that called `fs.readFile` could only be tested against a
 * real disk — with real permissions, real races, and real cleanup. Every other
 * subsystem in Hermes injects its slow, stateful edge (the kernel injects
 * `Clock`, memory injects `Database`, the agent framework injects the model), and
 * this is that edge for the filesystem. {@link MemoryFileSystem} lets the whole
 * tool suite run in-process, deterministically, with no `beforeEach` that shells
 * out to `mkdtemp`.
 *
 * **Safety, which matters more.** These tools take a `path` *from a model*. A
 * model asked to "read the config" may decide the config is at
 * `../../../../etc/shadow`, and a tool that passed that to `node:fs` would read
 * it. The port is where that is stopped: {@link rooted} wraps any filesystem in a
 * root and refuses every path that escapes it, so containment is a property of
 * one small, tested function rather than a rule every tool has to remember. See
 * RFC-0007 §4.
 *
 * ## What the port is, precisely
 *
 * The smallest set of operations the tools need, each taking an `AbortSignal`
 * because a filesystem call can block on a slow disk or a network mount and the
 * kernel's cancellation is cooperative (RFC-0001 §11.1). Bytes are
 * `Uint8Array`, not Node's `Buffer` — the port describes a filesystem, not
 * Node's, and a browser-backed or S3-backed implementation should satisfy it
 * without importing a Node type.
 */

import { FileSystemError } from './errors.js';

/** What a directory entry is, without reading it. */
export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface DirEntry {
  readonly name: string;
  readonly type: EntryType;
}

export interface FileStat {
  readonly type: EntryType;
  /** Size in bytes. 0 for a directory. */
  readonly size: number;
  /** Last modification time, epoch milliseconds. */
  readonly modifiedAt: number;
}

/**
 * The operations a filesystem tool needs.
 *
 * Every method takes an optional `AbortSignal` and is expected to honour it —
 * not as politeness but as the contract that keeps a stuck disk from holding a
 * kernel task slot forever. Every method throws {@link FileSystemError} with a
 * stable `code` on failure, so a tool never has to interpret a raw `ENOENT`.
 */
export interface FileSystem {
  /** Read a file's raw bytes. Throws `NOT_FOUND` if it is not there. */
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Write bytes, creating or truncating. Parent directory must exist. */
  writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** List a directory's entries. Throws `NOT_FOUND` if it is not a directory. */
  readdir(path: string, signal?: AbortSignal): Promise<readonly DirEntry[]>;
  /** Metadata for a path. Throws `NOT_FOUND` if it is not there. */
  stat(path: string, signal?: AbortSignal): Promise<FileStat>;
  /** Create a directory. `recursive` creates parents and tolerates existence. */
  mkdir(path: string, recursive: boolean, signal?: AbortSignal): Promise<void>;
  /** Remove a path. `recursive` is required to remove a non-empty directory. */
  remove(path: string, recursive: boolean, signal?: AbortSignal): Promise<void>;
  /** Move or rename. Fails if the destination's parent does not exist. */
  move(from: string, to: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Wrap a filesystem so every path is resolved against a root, and none escapes.
 *
 * **This is the security boundary, and it is deliberately tiny.** Every tool goes
 * through it, so containment is decided in one place that is fully tested rather
 * than re-implemented — and forgotten once — in eight tools.
 *
 * The rule: a requested path is resolved (`..` and `.` collapsed) against `root`,
 * and if the result is not `root` itself or under it, the call is refused with
 * `PATH_ESCAPE` before the wrapped filesystem is ever touched. Absolute paths a
 * model sends are re-rooted, not honoured: `/etc/passwd` under a root of
 * `/work` becomes `/work/etc/passwd`, which does not exist, rather than the real
 * `/etc/passwd`, which does.
 *
 * Symlinks are the one thing rooting alone cannot contain: a symlink inside the
 * root can point outside it, and only the underlying filesystem knows where it
 * resolves. That is documented as a limitation (RFC-0007 §7.1) rather than
 * papered over, because a real fix needs `realpath` on every operation and a
 * decision about whether to follow links at all, which belongs to the
 * implementation, not the wrapper.
 */
export function rooted(inner: FileSystem, root: string): FileSystem {
  const normalisedRoot = normalise(root);

  const contain = (path: string): string => {
    const resolved = resolveWithin(normalisedRoot, path);
    if (resolved === null) {
      throw new FileSystemError(
        'PATH_ESCAPE',
        path,
        `resolves outside the permitted root "${normalisedRoot}". ` +
          `Paths are relative to that root and cannot escape it`,
      );
    }
    return resolved;
  };

  // Every method is `async` so a containment failure is a *rejected promise*, not
  // a synchronous throw. A caller writing `fs.readFile(p).catch(...)` expects the
  // rejection to land in the catch; an arrow that threw before returning a
  // promise would sail straight past it and become an unhandled exception.
  return {
    readFile: async (path, signal) => inner.readFile(contain(path), signal),
    writeFile: async (path, data, signal) =>
      inner.writeFile(contain(path), data, signal),
    readdir: async (path, signal) => inner.readdir(contain(path), signal),
    stat: async (path, signal) => inner.stat(contain(path), signal),
    mkdir: async (path, recursive, signal) =>
      inner.mkdir(contain(path), recursive, signal),
    remove: async (path, recursive, signal) =>
      inner.remove(contain(path), recursive, signal),
    // Both ends are contained: a move is a read and a write, and either being
    // able to escape would defeat the point.
    move: async (from, to, signal) => inner.move(contain(from), contain(to), signal),
  };
}

/**
 * Resolve `path` within `root`, or return `null` if it escapes.
 *
 * Exported because it is the one piece of logic worth testing on its own, away
 * from any filesystem: the whole safety argument reduces to "does this function
 * ever return a path outside root", and that is a question about strings.
 *
 * The algorithm is POSIX-style and deliberately does not consult the disk (no
 * `realpath`): it is a pure function of the two strings, so it cannot be defeated
 * by a filesystem race between the check and the use. A leading `/` on `path` is
 * treated as "relative to root", not "absolute", which is what re-roots a model's
 * `/etc/passwd` into harmlessness.
 */
export function resolveWithin(root: string, path: string): string | null {
  const rootParts = split(root);
  // A leading slash is stripped by `split`, so an absolute-looking path from a
  // model is resolved against the root exactly as a relative one would be.
  const parts = [...rootParts];

  for (const segment of split(path)) {
    if (segment === '..') {
      // Refuse to pop above the root. `pop`-ing a segment that belongs to the
      // root would let `../` walk out, which is the whole attack.
      if (parts.length <= rootParts.length) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  return '/' + parts.join('/');
}

/** Split a POSIX path into meaningful segments, dropping `.` and empties. */
function split(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/** Collapse a path to a canonical absolute form for use as a root. */
function normalise(path: string): string {
  return '/' + split(path).join('/');
}
