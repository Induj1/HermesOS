/**
 * The filesystem toolset — the one call a host makes.
 *
 * Wraps {@link filesystemTools} in a `toolset` so the whole group registers,
 * tags, and is permission-guarded in one act. This is the shape a host actually
 * wants: it does not care about eight individual tools, it cares about "give this
 * runtime a rooted filesystem the agent may read but not write", and that is one
 * function call.
 */

import { PermissionSet, toolset } from '@hermes/tools';
import type { Plugin } from '@hermes/kernel';
import { rooted, type FileSystem } from './filesystem.js';
import { filesystemTools, type FilesystemToolsOptions } from './tools.js';

export interface FilesystemToolsetOptions extends FilesystemToolsOptions {
  /**
   * The filesystem to expose. Required.
   *
   * There is no default, and that is deliberate: a filesystem toolset with a
   * default filesystem would either expose the whole disk (a security hole
   * nobody opted into) or an empty memory filesystem (a surprise that does
   * nothing). A host must say which filesystem, because that choice *is* the
   * security decision.
   */
  readonly fs: FileSystem;
  /**
   * Confine every path to this root. Strongly recommended.
   *
   * When set, {@link rooted} wraps the filesystem so no path escapes — a model
   * asking for `../../etc/passwd` is refused. When absent, the filesystem is
   * exposed as-is, which is only safe if the filesystem is *itself* confined (an
   * empty `MemoryFileSystem`, an already-rooted mount). The option is here rather
   * than assumed so that "unrooted" is a visible, deliberate choice in a host's
   * wiring, not a default someone forgot to change.
   */
  readonly root?: string;
  /**
   * What the tools are allowed to do. Defaults to read-only.
   *
   * Read-only is the safe default because the dangerous direction is write, and a
   * default that could delete files is a default that will. A host that wants
   * writes grants them explicitly — which is exactly the audit trail a reviewer
   * wants: "who granted this agent fs:write" has an answer in the wiring.
   */
  readonly granted?: PermissionSet;
  /** The plugin's name. Defaults to `filesystem`. */
  readonly name?: string;
}

/**
 * Wire filesystem tools into a runtime.
 *
 * ```ts
 * runtime.use(filesystemToolset({
 *   fs: new NodeFileSystem(),
 *   root: '/srv/hermes/workspace',
 *   granted: PermissionSet.none().grant('fs:read', 'fs:write'),
 * }));
 * ```
 */
export function filesystemToolset(options: FilesystemToolsetOptions): Plugin {
  const fs = options.root === undefined ? options.fs : rooted(options.fs, options.root);

  return toolset({
    name: options.name ?? 'filesystem',
    tags: ['filesystem'],
    granted: options.granted ?? PermissionSet.none().grant('fs:read'),
    tools: filesystemTools(fs, options),
  });
}
