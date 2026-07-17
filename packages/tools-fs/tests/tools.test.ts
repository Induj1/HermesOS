/**
 * The filesystem tools, exercised through the framework that validates them.
 *
 * `callTool` runs the input schema before `execute`, so these test the tools the
 * way a model reaches them — malformed input and all. The filesystem underneath
 * is {@link MemoryFileSystem}, so every test is deterministic and touches no disk.
 */

import { describe, expect, it } from 'vitest';
import { auditTool, callTool, PermissionSet, withPermissions } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';
import { filesystemTools, DEFAULT_MAX_BYTES } from '../src/tools.js';
import { MemoryFileSystem } from '../src/memory-filesystem.js';
import { rooted, type FileSystem } from '../src/filesystem.js';
import { PermissionDeniedError } from '@hermes/tools';

const tools = (
  fs: FileSystem = MemoryFileSystem.withFiles({
    '/a.txt': 'hello',
    '/dir/b.txt': 'world',
  }),
) => {
  const map = new Map<string, HermesTool>();
  for (const tool of filesystemTools(fs)) map.set(tool.name, tool);
  return {
    fs,
    get: (name: string): HermesTool => {
      const tool = map.get(name);
      if (tool === undefined) throw new Error(`test asked for unknown tool "${name}"`);
      return tool;
    },
  };
};

describe('every tool has a coherent declaration', () => {
  // The framework's own auditor, run against every tool: an example that violates
  // its schema, a description too short to choose by. Cheap insurance that a
  // model is being told the truth.
  it.each(filesystemTools(new MemoryFileSystem()).map((t) => [t.name, t] as const))(
    '%s passes auditTool',
    (_name, tool) => {
      expect(auditTool(tool)).toEqual([]);
    },
  );
});

describe('fs.read', () => {
  it('reads a file', async () => {
    expect(await callTool(tools().get('fs.read'), { path: 'a.txt' })).toBe('hello');
  });

  it('rejects a missing path field before touching the filesystem', async () => {
    await expect(callTool(tools().get('fs.read'), {})).rejects.toThrow(
      /"path" is required/,
    );
  });

  it('refuses to read a directory', async () => {
    await expect(
      callTool(tools().get('fs.read'), { path: 'dir' }),
    ).rejects.toMatchObject({
      code: 'IS_A_DIRECTORY',
    });
  });

  // The cap is checked from stat before the read, so an oversized file is refused
  // without being loaded.
  it('refuses a file over maxBytes, naming the size', async () => {
    const { fs, get } = tools(
      MemoryFileSystem.withFiles({ '/big.txt': 'x'.repeat(100) }),
    );
    void fs;

    await expect(
      callTool(get('fs.read'), { path: 'big.txt', maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('reads up to the default cap', async () => {
    expect(DEFAULT_MAX_BYTES).toBe(1024 * 1024);
    expect(await callTool(tools().get('fs.read'), { path: 'a.txt' })).toBe('hello');
  });

  // A model handed the mojibake of a decoded binary gains nothing; a clear error
  // is better than noise that looks like data.
  it('refuses a binary file rather than returning garbage', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile('/img.png', new Uint8Array([0x89, 0x50, 0x00, 0x01]));

    await expect(
      callTool(tools(fs).get('fs.read'), { path: 'img.png' }),
    ).rejects.toMatchObject({
      code: 'NOT_TEXT',
    });
  });

  it('refuses invalid UTF-8', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile('/bad.txt', new Uint8Array([0xff, 0xfe, 0xfd]));

    await expect(
      callTool(tools(fs).get('fs.read'), { path: 'bad.txt' }),
    ).rejects.toMatchObject({
      code: 'NOT_TEXT',
    });
  });
});

describe('fs.write', () => {
  it('writes and reports the byte count', async () => {
    const { fs, get } = tools();

    const result = await callTool(get('fs.write'), {
      path: 'new.txt',
      content: 'fresh',
    });

    expect(result).toEqual({ path: 'new.txt', bytesWritten: 5 });
    expect(await fs.readFile('/new.txt')).toEqual(new TextEncoder().encode('fresh'));
  });

  it('counts bytes, not characters, for multi-byte content', async () => {
    const { get } = tools();

    // '€' is three UTF-8 bytes; a tool that reported string length would say 1.
    expect(
      await callTool(get('fs.write'), { path: 'x.txt', content: '€' }),
    ).toMatchObject({
      bytesWritten: 3,
    });
  });
});

describe('fs.list', () => {
  it('lists the root by default', async () => {
    const result = await callTool(tools().get('fs.list'), {});

    expect(result).toEqual([
      { name: 'a.txt', type: 'file' },
      { name: 'dir', type: 'directory' },
    ]);
  });

  it('lists a named directory', async () => {
    expect(await callTool(tools().get('fs.list'), { path: 'dir' })).toEqual([
      { name: 'b.txt', type: 'file' },
    ]);
  });
});

describe('fs.stat', () => {
  it('reports type and size', async () => {
    expect(await callTool(tools().get('fs.stat'), { path: 'a.txt' })).toMatchObject({
      type: 'file',
      size: 5,
    });
  });
});

describe('fs.exists', () => {
  it('is true with a type for a path that exists', async () => {
    expect(await callTool(tools().get('fs.exists'), { path: 'a.txt' })).toEqual({
      exists: true,
      type: 'file',
    });
  });

  it('is false for a path that does not', async () => {
    expect(await callTool(tools().get('fs.exists'), { path: 'nope.txt' })).toEqual({
      exists: false,
    });
  });

  // A probe must not turn "forbidden" into "absent" — that would leak the
  // difference it exists to hide.
  it('propagates a non-NOT_FOUND failure rather than reporting absent', async () => {
    const fs = rooted(new MemoryFileSystem(), '/root');

    await expect(
      callTool(tools(fs).get('fs.exists'), { path: '../escape' }),
    ).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });
});

describe('fs.mkdir, fs.remove, fs.move', () => {
  it('creates a nested directory', async () => {
    const { fs, get } = tools();

    await callTool(get('fs.mkdir'), { path: 'x/y/z' });

    expect(await fs.stat('/x/y/z')).toMatchObject({ type: 'directory' });
  });

  it('removes a file', async () => {
    const { fs, get } = tools();

    await callTool(get('fs.remove'), { path: 'a.txt' });

    await expect(fs.stat('/a.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('needs recursive to remove a non-empty directory', async () => {
    await expect(
      callTool(tools().get('fs.remove'), { path: 'dir' }),
    ).rejects.toMatchObject({
      code: 'IS_A_DIRECTORY',
    });
  });

  it('moves a file', async () => {
    const { fs, get } = tools();

    await callTool(get('fs.move'), { from: 'a.txt', to: 'b.txt' });

    expect(new TextDecoder().decode(await fs.readFile('/b.txt'))).toBe('hello');
  });
});

describe('permissions', () => {
  // The read/write split falls out of the declared permissions: grant fs:read
  // and the write tools refuse.
  it('lets a read tool through a read-only grant', async () => {
    const read = withPermissions(
      tools().get('fs.read'),
      PermissionSet.none().grant('fs:read'),
    );

    expect(await callTool(read, { path: 'a.txt' })).toBe('hello');
  });

  it('refuses a write tool under a read-only grant', async () => {
    const write = withPermissions(
      tools().get('fs.write'),
      PermissionSet.none().grant('fs:read'),
    );

    await expect(callTool(write, { path: 'x.txt', content: 'y' })).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});

describe('cancellation', () => {
  it('honours an aborted signal', async () => {
    await expect(
      callTool(
        tools().get('fs.read'),
        { path: 'a.txt' },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
  });
});
