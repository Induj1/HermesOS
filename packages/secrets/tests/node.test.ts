/**
 * The Node FileReader — a real temp file: reads contents, missing → undefined,
 * other errors propagate.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeFileReader } from '../src/node.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hermes-secrets-'));
  await writeFile(join(dir, 'token'), 'file-secret\n', 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('nodeFileReader', () => {
  it('reads an existing file', async () => {
    const read = nodeFileReader();
    expect(await read(join(dir, 'token'))).toBe('file-secret\n');
  });

  it('returns undefined for a missing file (ENOENT)', async () => {
    const read = nodeFileReader();
    expect(await read(join(dir, 'does-not-exist'))).toBeUndefined();
  });

  it('propagates a non-ENOENT error (reading a directory)', async () => {
    const read = nodeFileReader();
    // Reading the directory itself is EISDIR, not ENOENT — a misconfiguration
    // the operator must see, so it must throw rather than resolve undefined.
    await expect(read(dir)).rejects.toThrow();
  });
});
