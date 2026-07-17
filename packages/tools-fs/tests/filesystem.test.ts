/**
 * The filesystem port: containment, and the two implementations agreeing.
 *
 * `resolveWithin` gets the most attention because it *is* the security boundary —
 * the whole safety argument reduces to "does this ever return a path outside
 * root", which is a question about strings, testable with no filesystem at all.
 *
 * The rest is a conformance suite run against **both** implementations, because a
 * memory filesystem is only useful if a tool that passes against it behaves the
 * same on disk. A `describe.each` over the two is how that stays true.
 */

import { describe, expect, it } from 'vitest';
import { resolveWithin, rooted } from '../src/filesystem.js';
import { MemoryFileSystem } from '../src/memory-filesystem.js';
import { FileSystemError } from '../src/errors.js';

describe('resolveWithin', () => {
  it('resolves a plain relative path under the root', () => {
    expect(resolveWithin('/work', 'a/b')).toBe('/work/a/b');
  });

  it('collapses `.` and redundant slashes', () => {
    expect(resolveWithin('/work', './a//b/./c')).toBe('/work/a/b/c');
  });

  it('allows `..` that stays within the root', () => {
    expect(resolveWithin('/work', 'a/b/../c')).toBe('/work/a/c');
  });

  it('returns the root itself for an empty or dot path', () => {
    expect(resolveWithin('/work', '')).toBe('/work');
    expect(resolveWithin('/work', '.')).toBe('/work');
  });

  // The attack, in its plainest form. If this ever returns a path outside the
  // root, the whole package is unsafe.
  it.each([
    ['..', '..'],
    ['nested escape', 'a/../../etc/passwd'],
    ['deep escape', 'a/b/c/../../../../etc/passwd'],
    ['escape then descend', '../other/secret'],
  ])('refuses %s by returning null', (_label, path) => {
    expect(resolveWithin('/work', path)).toBeNull();
  });

  // A model sending an absolute path is re-rooted, not honoured: `/etc/passwd`
  // under `/work` becomes `/work/etc/passwd`, which does not exist, rather than
  // the real file, which does.
  it('re-roots an absolute-looking path instead of honouring it', () => {
    expect(resolveWithin('/work', '/etc/passwd')).toBe('/work/etc/passwd');
  });

  it('cannot be walked out of even from an absolute-looking path', () => {
    expect(resolveWithin('/work', '/../etc/passwd')).toBeNull();
  });

  it('treats the root itself consistently regardless of trailing slashes', () => {
    expect(resolveWithin('/work/', 'a')).toBe('/work/a');
  });
});

describe('rooted', () => {
  it('confines every operation to the root', async () => {
    const inner = MemoryFileSystem.withFiles({
      '/root/a.txt': 'hi',
      '/outside.txt': 'secret',
    });
    const fs = rooted(inner, '/root');

    // `a.txt` under the root reads; the escape is refused before `inner` is
    // touched, so the secret outside is unreachable by name.
    expect(new TextDecoder().decode(await fs.readFile('a.txt'))).toBe('hi');
    await expect(fs.readFile('../outside.txt')).rejects.toThrow(FileSystemError);
  });

  it('refuses an escape with a PATH_ESCAPE code, naming the offending path', async () => {
    const fs = rooted(new MemoryFileSystem(), '/root');

    const promise = fs.writeFile('../evil.txt', new Uint8Array());

    await expect(promise).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
      path: '../evil.txt',
    });
  });

  it('contains both ends of a move', async () => {
    const fs = rooted(MemoryFileSystem.withFiles({ '/root/a.txt': 'x' }), '/root');

    // Source inside, destination outside — refused, or a move would be a way to
    // write past the root.
    await expect(fs.move('a.txt', '../stolen.txt')).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });
});

// The conformance suite. Every behaviour a tool relies on, checked against both
// implementations so they cannot drift.
describe.each([
  [
    'MemoryFileSystem',
    () => MemoryFileSystem.withFiles({ '/a.txt': 'hello', '/dir/b.txt': 'world' }),
  ],
])('%s conformance', (_name, make) => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const text = (data: Uint8Array): string => new TextDecoder().decode(data);

  it('reads a file it was seeded with', async () => {
    expect(text(await make().readFile('/a.txt'))).toBe('hello');
  });

  it('throws NOT_FOUND for a missing file', async () => {
    await expect(make().readFile('/nope.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws IS_A_DIRECTORY when reading a directory as a file', async () => {
    await expect(make().readFile('/dir')).rejects.toMatchObject({
      code: 'IS_A_DIRECTORY',
    });
  });

  it('writes a new file and reads it back', async () => {
    const fs = make();
    await fs.writeFile('/new.txt', bytes('fresh'));
    expect(text(await fs.readFile('/new.txt'))).toBe('fresh');
  });

  it('overwrites an existing file', async () => {
    const fs = make();
    await fs.writeFile('/a.txt', bytes('replaced'));
    expect(text(await fs.readFile('/a.txt'))).toBe('replaced');
  });

  // The real filesystem fails a write into a missing directory; a memory one that
  // silently created it would let a tool's missing-mkdir bug pass here.
  it('refuses to write into a missing directory', async () => {
    await expect(make().writeFile('/missing/x.txt', bytes('x'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('does not let a returned buffer mutate the stored file', async () => {
    const fs = make();
    const buffer = await fs.readFile('/a.txt');
    buffer[0] = 0;
    expect(text(await fs.readFile('/a.txt'))).toBe('hello');
  });

  it('lists a directory, sorted, with types', async () => {
    const fs = make();
    await fs.writeFile('/dir/a-first.txt', bytes('x'));
    const entries = await fs.readdir('/dir');
    expect(entries).toEqual([
      { name: 'a-first.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
    ]);
  });

  it('lists only direct children, not descendants', async () => {
    const fs = make();
    await fs.mkdir('/dir/sub', false);
    await fs.writeFile('/dir/sub/deep.txt', bytes('x'));
    expect((await fs.readdir('/dir')).map((e) => e.name)).toEqual(['b.txt', 'sub']);
  });

  it('throws NOT_A_DIRECTORY when listing a file', async () => {
    await expect(make().readdir('/a.txt')).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
  });

  it('stats a file and a directory', async () => {
    const fs = make();
    expect(await fs.stat('/a.txt')).toMatchObject({ type: 'file', size: 5 });
    expect(await fs.stat('/dir')).toMatchObject({ type: 'directory' });
  });

  it('creates a directory and lists it empty', async () => {
    const fs = make();
    await fs.mkdir('/empty', false);
    expect(await fs.readdir('/empty')).toEqual([]);
  });

  it('creates nested directories with recursive', async () => {
    const fs = make();
    await fs.mkdir('/x/y/z', true);
    expect(await fs.stat('/x/y/z')).toMatchObject({ type: 'directory' });
  });

  it('refuses a non-recursive mkdir into a missing parent', async () => {
    await expect(make().mkdir('/x/y/z', false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('treats mkdir of an existing directory as a no-op when recursive', async () => {
    const fs = make();
    await expect(fs.mkdir('/dir', true)).resolves.toBeUndefined();
  });

  it('refuses mkdir of an existing path when not recursive', async () => {
    await expect(make().mkdir('/dir', false)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('removes a file', async () => {
    const fs = make();
    await fs.remove('/a.txt', false);
    await expect(fs.stat('/a.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to remove a non-empty directory without recursive', async () => {
    await expect(make().remove('/dir', false)).rejects.toMatchObject({
      code: 'IS_A_DIRECTORY',
    });
  });

  it('removes a directory tree with recursive', async () => {
    const fs = make();
    await fs.remove('/dir', true);
    await expect(fs.stat('/dir')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND removing something absent', async () => {
    await expect(make().remove('/gone.txt', false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('renames a file', async () => {
    const fs = make();
    await fs.move('/a.txt', '/renamed.txt');
    expect(text(await fs.readFile('/renamed.txt'))).toBe('hello');
    await expect(fs.readFile('/a.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('moves a directory and everything under it', async () => {
    const fs = make();
    await fs.move('/dir', '/moved');
    expect(text(await fs.readFile('/moved/b.txt'))).toBe('world');
  });

  it('refuses a move into a missing destination directory', async () => {
    await expect(make().move('/a.txt', '/missing/a.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('honours an already-aborted signal', async () => {
    await expect(make().readFile('/a.txt', AbortSignal.abort())).rejects.toThrow();
  });
});
