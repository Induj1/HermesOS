/**
 * An in-memory filesystem — the default for tests, and a real implementation.
 *
 * It is not a mock. It enforces the same rules the real one does — a write into a
 * missing directory fails, removing a non-empty directory needs `recursive`,
 * reading a directory as a file is an error — so a tool that passes against this
 * behaves the same against `NodeFileSystem`. A mock that returned whatever a test
 * wanted would let a tool's bug pass here and fail on disk, which is the exact
 * failure a test filesystem exists to prevent.
 *
 * It is also useful in production: a host that wants a scratch space that
 * vanishes on restart, or a sandbox a model genuinely cannot escape because there
 * is no disk under it, wires this instead of {@link NodeFileSystem}. That is the
 * payoff of the port being an interface rather than a Node detail.
 *
 * ## Storage model
 *
 * A flat map from absolute path to bytes, plus a set of directory paths.
 * Directories are tracked explicitly rather than inferred from file paths,
 * because `mkdir` then `readdir` on an empty directory must work — a filesystem
 * where an empty directory does not exist is not a filesystem.
 */

import { FileSystemError } from './errors.js';
import type { DirEntry, FileStat, FileSystem } from './filesystem.js';

interface Node {
  readonly type: 'file' | 'directory';
  /** A file's bytes; empty for a directory. Always present, so no read needs a fallback. */
  data: Uint8Array;
  modifiedAt: number;
}

const NO_DATA = new Uint8Array();

export interface MemoryFileSystemOptions {
  /**
   * A clock, so timestamps are deterministic in a test.
   *
   * Injected for the same reason the kernel injects one: a `modifiedAt` that came
   * from `Date.now()` would make a checkpointed `stat` result differ every run,
   * and a test asserting on it would be flaky by construction.
   *
   * A property signature, not a method shorthand, so it can be stored and called
   * as a plain function without detaching a `this` it never had.
   */
  readonly now?: () => number;
}

export class MemoryFileSystem implements FileSystem {
  readonly #nodes = new Map<string, Node>();
  readonly #now: () => number;

  constructor(options: MemoryFileSystemOptions = {}) {
    // Bound through a local rather than assigned directly: passing `options.now`
    // as a bare method reference detaches it from its object, and a `now` that
    // read `this` would break. The arrow keeps the call attached.
    this.#now = options.now ?? ((): number => 0);
    // The root always exists. A filesystem whose root is not a directory cannot
    // be listed or written into, which makes it useless from the first call.
    this.#nodes.set('/', { type: 'directory', data: NO_DATA, modifiedAt: this.#now() });
  }

  /** Seed files from a plain object, for a test that wants a starting tree. */
  static withFiles(
    files: Record<string, string>,
    options: MemoryFileSystemOptions = {},
  ): MemoryFileSystem {
    const fs = new MemoryFileSystem(options);
    for (const [path, content] of Object.entries(files)) {
      fs.#ensureParents(normalise(path));
      fs.#nodes.set(normalise(path), {
        type: 'file',
        data: encode(content),
        modifiedAt: fs.#now(),
      });
    }
    return fs;
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const node = this.#require(path);
    if (node.type === 'directory') {
      throw new FileSystemError('IS_A_DIRECTORY', path, 'is a directory, not a file');
    }
    // A copy, so a caller mutating the returned bytes cannot reach back into the
    // stored file — the same isolation the real filesystem gives for free. No
    // fallback: every node carries `data`, empty for a directory.
    return Promise.resolve(node.data.slice());
  }

  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const key = normalise(path);
    const existing = this.#nodes.get(key);
    if (existing?.type === 'directory') {
      throw new FileSystemError(
        'IS_A_DIRECTORY',
        path,
        'is a directory and cannot be written as a file',
      );
    }
    // The parent must exist. `node:fs` fails a write into a missing directory,
    // and a memory filesystem that silently created one would let a tool's
    // missing-mkdir bug pass here and fail on disk.
    this.#requireDir(parent(key), path);
    this.#nodes.set(key, { type: 'file', data: data.slice(), modifiedAt: this.#now() });
    return Promise.resolve();
  }

  async readdir(path: string, signal?: AbortSignal): Promise<readonly DirEntry[]> {
    signal?.throwIfAborted();
    const node = this.#require(path);
    if (node.type !== 'directory') {
      throw new FileSystemError('NOT_A_DIRECTORY', path, 'is not a directory');
    }
    const prefix = normalise(path) === '/' ? '/' : normalise(path) + '/';
    const entries: DirEntry[] = [];
    for (const [key, child] of this.#nodes) {
      if (key === '/' || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      // Direct children only: `a/b/c` under `a` is not a child of `a`, `b` is.
      if (rest === '' || rest.includes('/')) continue;
      entries.push({ name: rest, type: child.type });
    }
    // Sorted, so a `readdir` result is deterministic. `node:fs` does not promise
    // order, and a tool that depended on the Map's insertion order would differ
    // between the two implementations.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return Promise.resolve(entries);
  }

  async stat(path: string, signal?: AbortSignal): Promise<FileStat> {
    signal?.throwIfAborted();
    const node = this.#require(path);
    return Promise.resolve({
      type: node.type,
      size: node.data.length,
      modifiedAt: node.modifiedAt,
    });
  }

  async mkdir(path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const key = normalise(path);
    const existing = this.#nodes.get(key);
    if (existing !== undefined) {
      // Existing directory + recursive is a no-op, matching `node:fs`. Existing
      // anything else, or non-recursive, is a conflict.
      if (existing.type === 'directory' && recursive) return Promise.resolve();
      throw new FileSystemError('ALREADY_EXISTS', path, 'already exists');
    }
    if (recursive) {
      this.#ensureParents(key);
    } else {
      this.#requireDir(parent(key), path);
    }
    this.#nodes.set(key, { type: 'directory', data: NO_DATA, modifiedAt: this.#now() });
    return Promise.resolve();
  }

  async remove(path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const key = normalise(path);
    const node = this.#require(path);
    if (node.type === 'directory') {
      const children = [...this.#nodes.keys()].filter(
        (k) => k !== key && k.startsWith(key + '/'),
      );
      if (children.length > 0 && !recursive) {
        throw new FileSystemError(
          'IS_A_DIRECTORY',
          path,
          'is a directory that is not empty; removing it needs the recursive option',
        );
      }
      for (const child of children) this.#nodes.delete(child);
    }
    this.#nodes.delete(key);
    return Promise.resolve();
  }

  async move(from: string, to: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const fromKey = normalise(from);
    const node = this.#require(from);
    const toKey = normalise(to);
    this.#requireDir(parent(toKey), to);

    // Move the node and, if it is a directory, everything under it — a rename of
    // `a` to `b` must carry `a/x` to `b/x`, which `node:fs` does atomically.
    // Iterated as entries rather than keys so each value is already in hand: a
    // `get` on a key from the same map cannot miss, and iterating entries makes
    // that a fact the types know rather than a branch to guard.
    const toMove = [...this.#nodes.entries()].filter(
      ([key]) => key === fromKey || key.startsWith(fromKey + '/'),
    );
    for (const [key, value] of toMove) {
      this.#nodes.delete(key);
      this.#nodes.set(toKey + key.slice(fromKey.length), value);
    }
    void node;
    return Promise.resolve();
  }

  #require(path: string): Node {
    const node = this.#nodes.get(normalise(path));
    if (node === undefined)
      throw new FileSystemError('NOT_FOUND', path, 'does not exist');
    return node;
  }

  #requireDir(key: string, original: string): void {
    const node = this.#nodes.get(key);
    if (node === undefined) {
      throw new FileSystemError(
        'NOT_FOUND',
        original,
        `cannot be created: "${key}" does not exist`,
      );
    }
    if (node.type !== 'directory') {
      throw new FileSystemError(
        'NOT_A_DIRECTORY',
        original,
        `cannot be created: "${key}" is not a directory`,
      );
    }
  }

  /** Create every missing parent directory of a path, as `mkdir -p` would. */
  #ensureParents(key: string): void {
    const segments = key.split('/').filter((s) => s !== '');
    let current = '';
    // Parents only — the last segment is the leaf being created, not a parent.
    for (const segment of segments.slice(0, -1)) {
      current += '/' + segment;
      const existing = this.#nodes.get(current);
      if (existing === undefined) {
        this.#nodes.set(current, {
          type: 'directory',
          data: NO_DATA,
          modifiedAt: this.#now(),
        });
      } else if (existing.type !== 'directory') {
        throw new FileSystemError(
          'NOT_A_DIRECTORY',
          key,
          `cannot be created: "${current}" is a file`,
        );
      }
    }
  }
}

function normalise(path: string): string {
  const parts = path.split('/').filter((s) => s !== '' && s !== '.');
  return '/' + parts.join('/');
}

function parent(key: string): string {
  const index = key.lastIndexOf('/');
  return index <= 0 ? '/' : key.slice(0, index);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
