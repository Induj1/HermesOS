/**
 * Secret sources — env (with NAME_FILE), file-per-secret, chain, and memory.
 */

import { describe, expect, it } from 'vitest';
import {
  ChainSecretSource,
  EnvSecretSource,
  FileSecretSource,
  MemorySecretSource,
  type FileReader,
} from '../src/source.js';

/** A FileReader over an in-memory map, so source tests touch no real disk. */
function fakeReader(files: Readonly<Record<string, string>>): FileReader {
  return (path) => Promise.resolve(path in files ? files[path] : undefined);
}

describe('MemorySecretSource', () => {
  it('returns present values and undefined for the rest', async () => {
    const s = new MemorySecretSource({ A: 'one', BLANK: '   ' });
    expect(await s.load('A')).toBe('one');
    expect(await s.load('MISSING')).toBeUndefined();
  });

  it('treats a blank value as absent', async () => {
    const s = new MemorySecretSource({ BLANK: '   ' });
    expect(await s.load('BLANK')).toBeUndefined();
  });
});

describe('EnvSecretSource', () => {
  it('reads a direct variable', async () => {
    const s = new EnvSecretSource({ TOKEN: 'abc' });
    expect(await s.load('TOKEN')).toBe('abc');
  });

  it('falls back to NAME_FILE and trims the file contents', async () => {
    const s = new EnvSecretSource(
      { TOKEN_FILE: '/run/secrets/token' },
      fakeReader({ '/run/secrets/token': '  file-value\n' }),
    );
    expect(await s.load('TOKEN')).toBe('file-value');
  });

  it('prefers the direct variable over NAME_FILE', async () => {
    const s = new EnvSecretSource(
      { TOKEN: 'direct', TOKEN_FILE: '/run/secrets/token' },
      fakeReader({ '/run/secrets/token': 'from-file' }),
    );
    expect(await s.load('TOKEN')).toBe('direct');
  });

  it('returns undefined when NAME_FILE is set but no reader is provided', async () => {
    const s = new EnvSecretSource({ TOKEN_FILE: '/run/secrets/token' });
    expect(await s.load('TOKEN')).toBeUndefined();
  });

  it('returns undefined when the NAME_FILE file is empty or missing', async () => {
    const s = new EnvSecretSource(
      { TOKEN_FILE: '/run/secrets/token' },
      fakeReader({ '/run/secrets/token': '   ' }),
    );
    expect(await s.load('TOKEN')).toBeUndefined();
  });

  it('returns undefined when nothing is set', async () => {
    const s = new EnvSecretSource({}, fakeReader({}));
    expect(await s.load('TOKEN')).toBeUndefined();
  });
});

describe('FileSecretSource', () => {
  it('reads <dir>/<name> and trims', async () => {
    const s = new FileSecretSource(
      '/run/secrets',
      fakeReader({ '/run/secrets/db': 'password\n' }),
    );
    expect(await s.load('db')).toBe('password');
  });

  it('normalizes a trailing slash on the directory', async () => {
    const s = new FileSecretSource(
      '/run/secrets/',
      fakeReader({ '/run/secrets/db': 'password' }),
    );
    expect(await s.load('db')).toBe('password');
  });

  it('returns undefined for a missing file', async () => {
    const s = new FileSecretSource('/run/secrets', fakeReader({}));
    expect(await s.load('nope')).toBeUndefined();
  });
});

describe('ChainSecretSource', () => {
  it('returns the first source that has the secret', async () => {
    const chain = new ChainSecretSource([
      new MemorySecretSource({}),
      new MemorySecretSource({ TOKEN: 'from-second' }),
      new MemorySecretSource({ TOKEN: 'from-third' }),
    ]);
    expect(await chain.load('TOKEN')).toBe('from-second');
  });

  it('returns undefined when no source has it', async () => {
    const chain = new ChainSecretSource([
      new MemorySecretSource({}),
      new MemorySecretSource({}),
    ]);
    expect(await chain.load('TOKEN')).toBeUndefined();
  });

  it('returns undefined for an empty chain', async () => {
    expect(await new ChainSecretSource([]).load('TOKEN')).toBeUndefined();
  });
});
