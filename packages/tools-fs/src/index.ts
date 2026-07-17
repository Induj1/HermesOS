/**
 * @hermes/tools-fs — filesystem tools for Hermes.
 *
 * Read, write, list, stat, and move files — as first-class {@link HermesTool}s, so
 * a model is told exactly what each takes and a host guards them with the
 * permission framework. Built on `@hermes/tools`; depends on nothing else but the
 * kernel.
 *
 * ## The two things that make these safe
 *
 * **A port, not `node:fs`.** Every tool talks to a {@link FileSystem} interface,
 * so the whole suite runs against {@link MemoryFileSystem} in a test with no disk,
 * and a host can swap in any backing store. `node:fs` lives in exactly one file
 * ({@link NodeFileSystem}).
 *
 * **A root, not raw paths.** {@link rooted} confines every path to a directory and
 * refuses escapes, so a model asking for `../../etc/passwd` is stopped before the
 * filesystem is touched. Containment is one small tested function, not a rule
 * eight tools have to remember.
 *
 * ## The intended shape of a host
 *
 * ```ts
 * import { filesystemToolset, NodeFileSystem } from '@hermes/tools-fs';
 * import { PermissionSet } from '@hermes/tools';
 *
 * runtime.use(filesystemToolset({
 *   fs: new NodeFileSystem(),
 *   root: '/srv/hermes/workspace',                       // paths cannot escape this
 *   granted: PermissionSet.none().grant('fs:read'),      // read-only by default
 * }));
 * ```
 *
 * See `docs/rfcs/RFC-0007-filesystem-tools.md` for why it is shaped this way.
 */

export { filesystemTools, DEFAULT_MAX_BYTES } from './tools.js';
export type { FilesystemToolsOptions } from './tools.js';

export { filesystemToolset } from './toolset.js';
export type { FilesystemToolsetOptions } from './toolset.js';

export { rooted, resolveWithin } from './filesystem.js';
export type { DirEntry, EntryType, FileStat, FileSystem } from './filesystem.js';

export { NodeFileSystem } from './node-filesystem.js';
export { MemoryFileSystem } from './memory-filesystem.js';
export type { MemoryFileSystemOptions } from './memory-filesystem.js';

export { FileSystemError, fromNodeError } from './errors.js';
export type { FileSystemErrorCode } from './errors.js';
