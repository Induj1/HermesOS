/**
 * The real filesystem, backed by `node:fs/promises`.
 *
 * This is the only file in the package that imports Node's `fs`, and that is
 * deliberate: it keeps the Node coupling in one place small enough to read at a
 * glance, so the tools above it depend on the port and nothing else. Everything
 * hard — path containment, cancellation, error shape — is handled by the layers
 * around it ({@link rooted}, {@link fromNodeError}), leaving this a thin
 * translation.
 *
 * ## Cancellation, honestly
 *
 * `node:fs/promises` accepts a `signal` on some calls (`readFile`, `writeFile`)
 * and not others (`stat`, `readdir`, `mkdir`, `rename`, `rm`). For the ones it
 * does, it is passed through. For the ones it does not, the signal is checked
 * *before* the call — so an already-cancelled operation does no work — but a call
 * in flight cannot be interrupted mid-syscall. That is the truth of the platform
 * rather than a shortcut, and it is the right amount of honesty: a `stat` is fast
 * enough that pre-checking is sufficient, and pretending otherwise would be a
 * lie in the one file whose job is to not lie about the filesystem.
 */

import {
  readFile,
  writeFile,
  readdir,
  lstat,
  mkdir,
  rm,
  rename,
} from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { fromNodeError } from './errors.js';
import type { DirEntry, EntryType, FileStat, FileSystem } from './filesystem.js';

export class NodeFileSystem implements FileSystem {
  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    try {
      // `readFile` honours the signal itself, so a large read is genuinely
      // interruptible rather than only pre-checked.
      return await readFile(path, { signal });
    } catch (thrown) {
      throw fromNodeError(path, thrown);
    }
  }

  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await writeFile(path, data, { signal });
    } catch (thrown) {
      throw fromNodeError(path, thrown);
    }
  }

  async readdir(path: string, signal?: AbortSignal): Promise<readonly DirEntry[]> {
    signal?.throwIfAborted();
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, type: entryType(entry) }));
    } catch (thrown) {
      throw fromNodeError(path, thrown);
    }
  }

  async stat(path: string, signal?: AbortSignal): Promise<FileStat> {
    signal?.throwIfAborted();
    try {
      // `lstat`, not `stat`: it reports the link *itself* rather than following
      // it. That is a security decision, not a detail. A `stat` that resolved the
      // link would silently report the target's type, so a symlink inside the
      // root pointing outside it would look like an ordinary file — the escape
      // rooting cannot catch (RFC-0007 §7.1), made invisible. Reporting `symlink`
      // gives a caller the chance to refuse to follow it.
      const stats = await lstat(path);
      return {
        type: statType(stats),
        size: stats.size,
        // Rounded to an integer: `mtimeMs` carries sub-millisecond noise that
        // would make a checkpointed result differ run to run for no reason.
        modifiedAt: Math.floor(stats.mtimeMs),
      };
    } catch (thrown) {
      throw fromNodeError(path, thrown);
    }
  }

  async mkdir(path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await mkdir(path, { recursive });
    } catch (thrown) {
      throw fromNodeError(path, thrown);
    }
  }

  async remove(path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      // `force: false` so removing something that is not there is a `NOT_FOUND`
      // rather than a silent success — a model that deleted a file expecting it
      // to exist should learn it did not.
      await rm(path, { recursive, force: false });
    } catch (thrown) {
      throw fromNodeError(path, thrown);
    }
  }

  async move(from: string, to: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await rename(from, to);
    } catch (thrown) {
      // The `from` path is the one a caller can act on: it is what they named,
      // and a rename failing for a missing source is the common case.
      throw fromNodeError(from, thrown);
    }
  }
}

function entryType(entry: Dirent): EntryType {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  // fifos, sockets and devices: reachable only for special files that cannot
  // be created portably in a test.
  /* v8 ignore next */
  return 'other';
}

function statType(stats: Stats): EntryType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  // fifos, sockets and devices: reachable only for special files that cannot
  // be created portably in a test.
  /* v8 ignore next */
  return 'other';
}
