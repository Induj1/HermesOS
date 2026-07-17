/**
 * The filesystem tools.
 *
 * A *factory* — `filesystemTools(fs)` — rather than a set of module-level
 * constants, because every tool closes over the injected {@link FileSystem}. That
 * is what lets a host wire a rooted, in-memory, or S3-backed filesystem without
 * the tools knowing, and it is why the whole suite is testable against
 * {@link MemoryFileSystem} with no disk in sight.
 *
 * ## Text, not bytes
 *
 * These tools deal in text. `fs.read` decodes UTF-8 and refuses anything that is
 * not valid UTF-8, and `fs.write` encodes it. A model reasons about text, not
 * bytes, and handing it the mojibake of a decoded PNG is worse than a clear
 * "this is not a text file" — it looks like data and is noise. A binary-aware
 * tool (base64, ranges) is a deliberate non-goal here; see RFC-0007 §7.2.
 *
 * ## The `maxBytes` cap is a safety limit, not a preference
 *
 * A model that asks to read a 2 GB log file would, without a cap, load it whole
 * into memory and then into a prompt — an out-of-memory crash or a ruinous token
 * bill. Every read is capped, the cap has a sane default, and exceeding it is a
 * structured `TOO_LARGE` error naming the size, so the model can ask for less
 * rather than being handed a truncated file it thinks is complete.
 */

import { defineTool, s, type HermesTool } from '@hermes/tools';
import { FileSystemError } from './errors.js';
import type { FileSystem } from './filesystem.js';

/** How many bytes a single `fs.read` will return before refusing. 1 MiB. */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface FilesystemToolsOptions {
  /** The default `maxBytes` for reads when a call does not set one. */
  readonly maxReadBytes?: number;
}

/**
 * Build the filesystem tools over an injected filesystem.
 *
 * The returned tools are plain {@link HermesTool}s: register them on a runtime,
 * wrap them in permissions, put them in a `toolset`. They declare `fs:read` and
 * `fs:write` so a host granting only `fs:read` gets a read-only filesystem for
 * free.
 */
export function filesystemTools(
  fs: FileSystem,
  options: FilesystemToolsOptions = {},
): readonly HermesTool[] {
  const defaultMax = options.maxReadBytes ?? DEFAULT_MAX_BYTES;

  const read = defineTool({
    name: 'fs.read',
    description: 'Read a UTF-8 text file and return its contents.',
    tags: ['filesystem', 'read'],
    permissions: ['fs:read'],
    idempotent: true,
    input: s.object({
      path: s.string({
        description: 'Path to the file, relative to the working root.',
      }),
      maxBytes: s.optional(
        s.number({
          integer: true,
          minimum: 1,
          description: `Refuse to read more than this many bytes. Defaults to ${String(defaultMax)}.`,
        }),
      ),
    }),
    output: s.string(),
    examples: [
      { description: 'Read a config file', input: { path: 'config/app.json' } },
    ],
    execute: async ({ path, maxBytes }, ctx) => {
      const limit = maxBytes ?? defaultMax;
      // Checked from stat before reading, so an oversized file is refused without
      // being loaded into memory first — a cap that only checked after the read
      // would have already paid the cost it exists to prevent.
      const info = await fs.stat(path, ctx.signal);
      if (info.type === 'directory') {
        throw new FileSystemError('IS_A_DIRECTORY', path, 'is a directory, not a file');
      }
      if (info.size > limit) {
        throw new FileSystemError(
          'TOO_LARGE',
          path,
          `is ${String(info.size)} bytes, over the ${String(limit)}-byte limit; ` +
            `read a smaller file or raise maxBytes`,
        );
      }
      const bytes = await fs.readFile(path, ctx.signal);
      return decodeText(path, bytes);
    },
  });

  const write = defineTool({
    name: 'fs.write',
    description: 'Write UTF-8 text to a file, creating it or replacing its contents.',
    tags: ['filesystem', 'write'],
    permissions: ['fs:write'],
    // Not idempotent: writing does not do the same thing twice — the second write
    // overwrites the first, and if the content came from a model it may differ.
    idempotent: false,
    input: s.object({
      path: s.string({
        description: 'Path to the file, relative to the working root.',
      }),
      content: s.string({ description: 'The full new contents of the file.' }),
    }),
    output: s.object({ path: s.string(), bytesWritten: s.number({ integer: true }) }),
    examples: [
      {
        description: 'Write a note',
        input: { path: 'notes/todo.txt', content: 'buy milk' },
        output: { path: 'notes/todo.txt', bytesWritten: 8 },
      },
    ],
    execute: async ({ path, content }, ctx) => {
      const bytes = new TextEncoder().encode(content);
      await fs.writeFile(path, bytes, ctx.signal);
      return { path, bytesWritten: bytes.length };
    },
  });

  const list = defineTool({
    name: 'fs.list',
    description: 'List the entries of a directory, each with its name and type.',
    tags: ['filesystem', 'read'],
    permissions: ['fs:read'],
    idempotent: true,
    input: s.object({
      path: s.withDefault(
        s.string({ description: 'Directory to list, relative to the working root.' }),
        '.',
      ),
    }),
    output: s.array(
      s.object({
        name: s.string(),
        type: s.enumOf(['file', 'directory', 'symlink', 'other']),
      }),
    ),
    examples: [{ description: 'List the root', input: {} }],
    execute: async ({ path }, ctx) => {
      const entries = await fs.readdir(path, ctx.signal);
      return entries.map((entry) => ({ name: entry.name, type: entry.type }));
    },
  });

  const stat = defineTool({
    name: 'fs.stat',
    description:
      'Get metadata for a path: its type, size in bytes, and modification time.',
    tags: ['filesystem', 'read'],
    permissions: ['fs:read'],
    idempotent: true,
    input: s.object({ path: s.string({ description: 'Path to inspect.' }) }),
    output: s.object({
      type: s.enumOf(['file', 'directory', 'symlink', 'other']),
      size: s.number({ integer: true }),
      modifiedAt: s.number({ integer: true, description: 'Epoch milliseconds.' }),
    }),
    examples: [{ description: 'Inspect a file', input: { path: 'README.md' } }],
    execute: async ({ path }, ctx) => {
      const info = await fs.stat(path, ctx.signal);
      return { type: info.type, size: info.size, modifiedAt: info.modifiedAt };
    },
  });

  const exists = defineTool({
    name: 'fs.exists',
    description: 'Check whether a path exists, without reading it.',
    tags: ['filesystem', 'read'],
    permissions: ['fs:read'],
    idempotent: true,
    input: s.object({ path: s.string({ description: 'Path to check.' }) }),
    output: s.object({ exists: s.boolean(), type: s.optional(s.string()) }),
    examples: [{ description: 'Check for a lockfile', input: { path: '.lock' } }],
    execute: async ({ path }, ctx) => {
      try {
        const info = await fs.stat(path, ctx.signal);
        return { exists: true, type: info.type };
      } catch (thrown) {
        // Only NOT_FOUND becomes `false`. A PERMISSION_DENIED or a PATH_ESCAPE is
        // a real failure the caller must see — reporting "does not exist" for a
        // path the caller may not access would leak the difference between
        // "absent" and "forbidden", which is exactly what a probe wants to hide.
        if (thrown instanceof FileSystemError && thrown.code === 'NOT_FOUND') {
          // `type: undefined` rather than omitting it: the output schema's
          // `optional` makes the value nullable, and the parse drops the key on
          // the way out, so the validated result is `{ exists: false }` all the
          // same.
          return { exists: false, type: undefined };
        }
        throw thrown;
      }
    },
  });

  const mkdir = defineTool({
    name: 'fs.mkdir',
    description: 'Create a directory, and its parents if needed.',
    tags: ['filesystem', 'write'],
    permissions: ['fs:write'],
    // Idempotent with recursive: making a directory that exists is a no-op, which
    // is exactly what makes re-running a recovery safe here.
    idempotent: true,
    input: s.object({
      path: s.string({ description: 'Directory to create.' }),
      recursive: s.withDefault(
        s.boolean({
          description: 'Create missing parents, and tolerate the directory existing.',
        }),
        true,
      ),
    }),
    output: s.object({ path: s.string() }),
    examples: [{ description: 'Create a nested directory', input: { path: 'a/b/c' } }],
    execute: async ({ path, recursive }, ctx) => {
      await fs.mkdir(path, recursive, ctx.signal);
      return { path };
    },
  });

  const remove = defineTool({
    name: 'fs.remove',
    description: 'Delete a file, or a directory and everything in it.',
    tags: ['filesystem', 'write'],
    permissions: ['fs:write'],
    idempotent: false,
    input: s.object({
      path: s.string({ description: 'Path to delete.' }),
      recursive: s.withDefault(
        s.boolean({ description: 'Required to delete a non-empty directory.' }),
        false,
      ),
    }),
    output: s.object({ path: s.string(), removed: s.boolean() }),
    examples: [
      { description: 'Delete a temp file', input: { path: 'tmp/scratch.txt' } },
    ],
    execute: async ({ path, recursive }, ctx) => {
      await fs.remove(path, recursive, ctx.signal);
      return { path, removed: true };
    },
  });

  const move = defineTool({
    name: 'fs.move',
    description: 'Move or rename a file or directory.',
    tags: ['filesystem', 'write'],
    permissions: ['fs:write'],
    idempotent: false,
    input: s.object({
      from: s.string({ description: 'The path to move.' }),
      to: s.string({ description: 'The destination path.' }),
    }),
    output: s.object({ from: s.string(), to: s.string() }),
    examples: [{ description: 'Rename a file', input: { from: 'a.txt', to: 'b.txt' } }],
    execute: async ({ from, to }, ctx) => {
      await fs.move(from, to, ctx.signal);
      return { from, to };
    },
  });

  return [read, write, list, stat, exists, mkdir, remove, move];
}

/**
 * Decode bytes as UTF-8 text, or refuse.
 *
 * `fatal: true` makes the decoder throw on an invalid sequence rather than
 * substituting the replacement character — because a file with one bad byte
 * decoded lossily is a file a model will reason about as if it were correct, and
 * silently corrupting a config it is about to rewrite is worse than refusing to
 * read it. A NUL byte is treated as the mark of a binary file for the same
 * reason: valid UTF-8 can contain NUL, but a text file almost never does, and a
 * model handed a decoded binary gains nothing.
 */
function decodeText(path: string, bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new FileSystemError(
      'NOT_TEXT',
      path,
      'appears to be binary (contains NUL bytes)',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileSystemError('NOT_TEXT', path, 'is not valid UTF-8 text');
  }
}
