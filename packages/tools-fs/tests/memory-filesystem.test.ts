/**
 * MemoryFileSystem edge cases the conformance suite does not reach.
 *
 * The shared conformance suite in `filesystem.test.ts` checks the happy paths and
 * the common errors against both implementations. These are the memory-only
 * corners: the conflicts that make it a faithful stand-in rather than a
 * permissive mock, and the injected clock that makes its timestamps
 * deterministic.
 */

import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/memory-filesystem.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('faithfulness — conflicts a mock would let slide', () => {
  it('refuses to write a file where a directory already is', async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir('/dir', false);

    await expect(fs.writeFile('/dir', bytes('x'))).rejects.toMatchObject({
      code: 'IS_A_DIRECTORY',
    });
  });

  it('refuses to mkdir where a file already is, even recursively through it', async () => {
    const fs = MemoryFileSystem.withFiles({ '/file': 'x' });

    await expect(fs.mkdir('/file/sub', true)).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
  });

  it('refuses a non-recursive mkdir whose parent is a file', async () => {
    const fs = MemoryFileSystem.withFiles({ '/file': 'x' });

    await expect(fs.mkdir('/file/sub', false)).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
  });

  it('reports NOT_FOUND when moving something absent', async () => {
    await expect(new MemoryFileSystem().move('/gone', '/there')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports NOT_FOUND when the move destination parent is missing', async () => {
    const fs = MemoryFileSystem.withFiles({ '/a.txt': 'x' });

    await expect(fs.move('/a.txt', '/missing/a.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('seeds nested files by creating their parent directories', async () => {
    const fs = MemoryFileSystem.withFiles({ '/deep/nested/file.txt': 'x' });

    expect((await fs.stat('/deep')).type).toBe('directory');
    expect((await fs.stat('/deep/nested')).type).toBe('directory');
  });

  it('reads an empty file as empty bytes, not a crash', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile('/empty', new Uint8Array());

    expect((await fs.readFile('/empty')).length).toBe(0);
    expect((await fs.stat('/empty')).size).toBe(0);
  });
});

describe('determinism — the injected clock', () => {
  it('stamps modifiedAt from the injected clock', async () => {
    let tick = 100;
    const fs = new MemoryFileSystem({ now: () => tick });

    await fs.writeFile('/a.txt', bytes('x'));
    expect((await fs.stat('/a.txt')).modifiedAt).toBe(100);

    tick = 200;
    await fs.writeFile('/a.txt', bytes('y'));
    expect((await fs.stat('/a.txt')).modifiedAt).toBe(200);
  });

  it('defaults to a zero clock, so a test that ignores time is stable', async () => {
    const fs = MemoryFileSystem.withFiles({ '/a.txt': 'x' });

    expect((await fs.stat('/a.txt')).modifiedAt).toBe(0);
  });
});
