import { MemoryFileSystem, rooted } from '@hermes/tools-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { lenientWorkspaceFs } from '../src/workspace-fs.js';

const ROOT = '/ws'; // basename "ws"
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

let fs: ReturnType<typeof lenientWorkspaceFs>;

beforeEach(async () => {
  fs = lenientWorkspaceFs(rooted(new MemoryFileSystem(), ROOT), ROOT);
  await fs.mkdir('.', true); // create the workspace root
});

describe('lenientWorkspaceFs', () => {
  it('auto-creates parent directories on write', async () => {
    await fs.writeFile('a/b/c.txt', enc('hi'));
    expect(dec(await fs.readFile('a/b/c.txt'))).toBe('hi');
  });

  it('normalises the absolute workspace path to relative', async () => {
    await fs.writeFile(`${ROOT}/x.txt`, enc('X'));
    expect(dec(await fs.readFile('x.txt'))).toBe('X');
  });

  it('strips a doubled workspace-name prefix and a leading slash', async () => {
    await fs.writeFile('ws/y.txt', enc('Y'));
    expect(dec(await fs.readFile('/y.txt'))).toBe('Y');
  });

  it('treats the absolute root and the bare workspace name as the root itself', async () => {
    await fs.writeFile('top.txt', enc('T'));
    // Absolute root path → "." ; bare basename → "" → "."
    expect((await fs.readdir(ROOT)).some((e) => e.name === 'top.txt')).toBe(true);
    expect((await fs.readdir('ws')).some((e) => e.name === 'top.txt')).toBe(true);
  });

  it('normalises paths for mkdir, stat, readdir, move, and remove', async () => {
    await fs.mkdir('/sub', true);
    await fs.writeFile('sub/a.txt', enc('A'));

    expect((await fs.stat(`${ROOT}/sub/a.txt`)).type).toBe('file');
    expect((await fs.readdir('sub')).length).toBeGreaterThan(0);

    await fs.move('sub/a.txt', 'moved/b.txt'); // dest parent auto-created
    expect(dec(await fs.readFile('moved/b.txt'))).toBe('A');

    await fs.remove('moved', true);
    await expect(fs.readFile('moved/b.txt')).rejects.toBeTruthy();
  });
});
