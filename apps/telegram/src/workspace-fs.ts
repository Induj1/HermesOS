/**
 * A forgiving filesystem wrapper for a chat-driven agent.
 *
 * A small local model is inconsistent about paths: it sends the workspace's
 * absolute path, a mistaken "/<workspace-name>/…" prefix, or a leading slash,
 * and it forgets to create a directory before writing into it. None of that is a
 * safety problem — the wrapped filesystem is already `rooted`, so an escape is
 * still refused — it is just friction that makes every file task fail.
 *
 * This wrapper removes the friction:
 * - It normalises an incoming path to one relative to the workspace, stripping
 *   the absolute root, a doubled workspace-name segment, and leading `./` / `/`.
 * - It creates the parent directory on write, so "write a/b/c.html" just works.
 *
 * Containment is unchanged: normalisation only strips known-safe leading
 * segments, and the inner `rooted` filesystem still refuses anything that
 * resolves outside the root.
 */

import path from 'node:path';
import type { FileSystem } from '@hermes/tools-fs';

/** Wrap a (rooted) filesystem to tolerate the paths a model actually sends. */
export function lenientWorkspaceFs(inner: FileSystem, rootAbs: string): FileSystem {
  const base = path.basename(rootAbs);

  const norm = (raw: string): string => {
    let s = raw.trim();
    // The real absolute workspace path → relative.
    if (s === rootAbs) return '.';
    if (s.startsWith(rootAbs + path.sep)) s = s.slice(rootAbs.length + 1);
    // A mistaken leading "<workspace-name>/" (the doubled-name guess).
    if (s === base) s = '';
    else if (s.startsWith(base + '/')) s = s.slice(base.length + 1);
    // Leading "./" or "/" repeated.
    s = s.replace(/^(\.?\/)+/, '');
    return s === '' ? '.' : s;
  };

  const ensureParent = async (
    normalised: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const dir = path.posix.dirname(normalised);
    if (dir !== '' && dir !== '.') await inner.mkdir(dir, true, signal);
  };

  return {
    readFile: (p, signal) => inner.readFile(norm(p), signal),
    writeFile: async (p, data, signal) => {
      const normalised = norm(p);
      await ensureParent(normalised, signal);
      return inner.writeFile(normalised, data, signal);
    },
    readdir: (p, signal) => inner.readdir(norm(p), signal),
    stat: (p, signal) => inner.stat(norm(p), signal),
    mkdir: (p, recursive, signal) => inner.mkdir(norm(p), recursive, signal),
    remove: (p, recursive, signal) => inner.remove(norm(p), recursive, signal),
    move: async (from, to, signal) => {
      const dest = norm(to);
      await ensureParent(dest, signal);
      return inner.move(norm(from), dest, signal);
    },
  };
}
