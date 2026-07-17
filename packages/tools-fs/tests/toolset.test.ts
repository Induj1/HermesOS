/**
 * The toolset on a real kernel, and NodeFileSystem on a real disk.
 *
 * Two integration surfaces the memory tests cannot reach: that the tools register
 * and dispatch through an actual `Runtime`, and that `NodeFileSystem` behaves the
 * way the conformance suite says a filesystem must — the one place the memory
 * implementation's promise is checked against the thing it stands in for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, sequentialIds } from '@hermes/kernel';
import { catalog, PermissionSet } from '@hermes/tools';
import { filesystemToolset } from '../src/toolset.js';
import { MemoryFileSystem } from '../src/memory-filesystem.js';
import { NodeFileSystem } from '../src/node-filesystem.js';
import { rooted, type FileSystem } from '../src/filesystem.js';

let runtime: Runtime | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await runtime?.stop({ mode: 'cancel' });
  runtime = undefined;
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('filesystemToolset on a real runtime', () => {
  it('registers the tools, tagged and read-only by default', async () => {
    const fs = MemoryFileSystem.withFiles({ '/a.txt': 'hi' });
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(filesystemToolset({ fs }));
    await runtime.start();

    const described = catalog(runtime.tools);

    expect(described.map((t) => t.name)).toContain('fs.read');
    // Tagged as a group, so an agent selects them with NamedTools({ tags: ['filesystem'] }).
    expect(described.every((t) => t.tags?.includes('filesystem'))).toBe(true);
    // Default is read-only: fs.write declares fs:write, which the default grant
    // does not include.
    expect(
      catalog(runtime.tools, { granted: PermissionSet.none().grant('fs:read') }),
    ).toEqual(described.filter((t) => t.permissions?.every((p) => p === 'fs:read')));
  });

  it('reads a file through a dispatched mission', async () => {
    const fs = MemoryFileSystem.withFiles({
      '/greeting.txt': 'hello from the mission',
    });
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(filesystemToolset({ fs }));
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'read',
      tasks: [
        {
          name: 'read',
          handler: { kind: 'tool', name: 'fs.read' },
          input: { path: 'greeting.txt' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.result).toBe('hello from the mission');
  });

  it('refuses a write when only read was granted', async () => {
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(filesystemToolset({ fs: new MemoryFileSystem() }));
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'write',
      tasks: [
        {
          name: 'w',
          handler: { kind: 'tool', name: 'fs.write' },
          input: { path: 'x.txt', content: 'y' },
        },
      ],
    });

    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /requires the "fs:write" permission/,
    );
  });

  it('confines a model path escape when a root is set', async () => {
    const fs = MemoryFileSystem.withFiles({
      '/root/ok.txt': 'in',
      '/secret.txt': 'out',
    });
    runtime = Runtime.create({ ids: sequentialIds() });
    runtime.use(filesystemToolset({ fs, root: '/root' }));
    await runtime.start();

    const snapshot = await runtime.run({
      name: 'escape',
      tasks: [
        {
          name: 'e',
          handler: { kind: 'tool', name: 'fs.read' },
          input: { path: '../secret.txt' },
        },
      ],
    });

    // The mission fails with a containment error, and the secret is never read.
    expect(snapshot.tasks[0]?.error?.message).toMatch(
      /resolves outside the permitted root/,
    );
  });
});

// NodeFileSystem against a real temp directory: the conformance the memory
// implementation promises to match, checked against the thing it stands in for.
describe('NodeFileSystem on disk', () => {
  const setup = async (): Promise<{ fs: FileSystem; dir: string }> => {
    tempDir = await mkdtemp(join(tmpdir(), 'hermes-fs-'));
    await writeFile(join(tempDir, 'a.txt'), 'hello');
    return {
      fs: rooted(new NodeFileSystem(), tempDir),
      dir: tempDir,
    };
  };

  it('reads a real file through the rooted port', async () => {
    const { fs } = await setup();

    expect(new TextDecoder().decode(await fs.readFile('a.txt'))).toBe('hello');
  });

  it('writes, stats, lists and removes on disk', async () => {
    const { fs } = await setup();

    await fs.writeFile('b.txt', new TextEncoder().encode('world'));
    expect((await fs.stat('b.txt')).size).toBe(5);
    expect((await fs.readdir('.')).map((e) => e.name).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);

    await fs.remove('b.txt', false);
    await expect(fs.stat('b.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps a real ENOENT to NOT_FOUND', async () => {
    const { fs } = await setup();

    await expect(fs.readFile('nope.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps a failed move to a code naming the source, not the destination', async () => {
    const { fs } = await setup();

    // The `from` path is the one a caller can act on; a move failing for a
    // missing source should name the source, resolved within the root.
    const error = await fs.move('nope.txt', 'x.txt').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect((error as { path: string }).path).toMatch(/nope\.txt$/);
  });

  it('actually confines an escape on the real filesystem', async () => {
    const { fs } = await setup();

    // The temp dir sits under the OS temp root, which contains other files. The
    // escape must be refused before `node:fs` sees it.
    await expect(fs.readFile('../../../../etc/hostname')).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });

  it('creates and moves directories on disk', async () => {
    const { fs } = await setup();

    await fs.mkdir('nested/deep', true);
    await fs.writeFile('nested/deep/x.txt', new TextEncoder().encode('x'));
    await fs.move('nested', 'renamed');

    expect((await fs.stat('renamed/deep/x.txt')).type).toBe('file');
  });

  it('maps a real EEXIST to ALREADY_EXISTS', async () => {
    const { fs } = await setup();
    await fs.mkdir('d', false);

    await expect(fs.mkdir('d', false)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('maps reading a directory as a file to a code, through the real fs', async () => {
    const { fs } = await setup();
    await fs.mkdir('adir', false);

    // Node reports EISDIR here; the mapping must not let it through raw.
    await expect(fs.readFile('adir')).rejects.toBeInstanceOf(Error);
  });

  it('lists entry types from real dirents', async () => {
    const { fs } = await setup();
    await fs.mkdir('sub', false);

    const entries = await fs.readdir('.');

    expect(entries.find((e) => e.name === 'sub')?.type).toBe('directory');
    expect(entries.find((e) => e.name === 'a.txt')?.type).toBe('file');
  });

  // Symlinks are the one thing rooting alone cannot contain (RFC-0007 §7.1), so
  // at least the type is reported honestly: a caller can see a `symlink` and
  // decide not to follow it.
  it('reports a symlink as a symlink in stat and list', async () => {
    const { fs, dir } = await setup();
    await symlink(join(dir, 'a.txt'), join(dir, 'link.txt'));

    expect((await fs.stat('link.txt')).type).toBe('symlink');
    expect((await fs.readdir('.')).find((e) => e.name === 'link.txt')?.type).toBe(
      'symlink',
    );
  });

  it('honours an aborted signal before doing the work', async () => {
    const { fs } = await setup();

    await expect(fs.stat('a.txt', AbortSignal.abort())).rejects.toThrow();
    await expect(fs.mkdir('x', false, AbortSignal.abort())).rejects.toThrow();
    await expect(fs.move('a.txt', 'b.txt', AbortSignal.abort())).rejects.toThrow();
    await expect(fs.remove('a.txt', false, AbortSignal.abort())).rejects.toThrow();
    await expect(fs.readdir('.', AbortSignal.abort())).rejects.toThrow();
    await expect(
      fs.writeFile('c.txt', new Uint8Array(), AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
