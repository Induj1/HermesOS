import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemClock } from '@hermes/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, cosineSimilarity, type EmbedFn } from '../src/memory-store.js';

const FILE = path.join(os.tmpdir(), 'hermes-memstore-test.json');

// A deterministic fake embedder: known texts map to fixed vectors so cosine
// ranking is predictable; anything else is orthogonal.
const vectors: Record<string, readonly number[]> = {
  'my name is Induj': [1, 0, 0],
  'what is my name?': [0.9, 0.1, 0],
  'I like coffee': [0, 1, 0],
};
const embed: EmbedFn = (texts) =>
  Promise.resolve(texts.map((t) => vectors[t] ?? [0, 0, 1]));

let ids = 0;
const opts = (over: Partial<Parameters<typeof MemoryStore.load>[0]> = {}) => ({
  embed,
  filePath: FILE,
  clock: systemClock,
  nextId: () => `id_${String((ids += 1))}`,
  ...over,
});

beforeEach(async () => {
  ids = 0;
  await fsp.rm(FILE, { force: true });
});
afterEach(async () => {
  await fsp.rm(FILE, { force: true });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, 0 for a zero vector', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    // A sparse/undefined slot is treated as 0 rather than NaN.
    expect(cosineSimilarity([undefined as unknown as number, 1], [1, 1])).toBeCloseTo(
      0.7071,
      3,
    );
  });
});

describe('MemoryStore', () => {
  it('remembers and recalls, ranked by similarity and scoped by subject', async () => {
    const store = await MemoryStore.load(opts());
    await store.remember({
      subject: 'A',
      kind: 'episode',
      content: 'my name is Induj',
    });
    await store.remember({ subject: 'A', kind: 'episode', content: 'I like coffee' });
    await store.remember({
      subject: 'B',
      kind: 'episode',
      content: 'my name is Induj',
    });

    const hits = await store.recall('A', 'what is my name?', { limit: 5 });
    expect(hits).toHaveLength(2); // subject B excluded
    expect(hits[0]?.memory.content).toBe('my name is Induj');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
  });

  it('returns empty for an unknown subject or a blank query', async () => {
    const store = await MemoryStore.load(opts());
    await store.remember({ subject: 'A', kind: 'fact', content: 'my name is Induj' });
    expect(await store.recall('Z', 'hi')).toEqual([]);
    expect(await store.recall('A', '   ')).toEqual([]);
  });

  it('respects minSimilarity', async () => {
    const store = await MemoryStore.load(opts());
    await store.remember({ subject: 'A', kind: 'fact', content: 'I like coffee' });
    // similarity of the query to "I like coffee" is 0.1 — below the floor.
    expect(await store.recall('A', 'what is my name?', { minSimilarity: 0.5 })).toEqual(
      [],
    );
  });

  it('persists across reloads', async () => {
    const store = await MemoryStore.load(opts());
    await store.remember({ subject: 'A', kind: 'fact', content: 'my name is Induj' });

    const reloaded = await MemoryStore.load(opts());
    expect(reloaded.size).toBe(1);
    expect((await reloaded.recall('A', 'what is my name?'))[0]?.memory.content).toBe(
      'my name is Induj',
    );
  });

  it('exposes a read-only memory adapter', async () => {
    const store = await MemoryStore.load(opts());
    await store.remember({ subject: 'A', kind: 'fact', content: 'my name is Induj' });
    const hits = await store.asMemoryAdapter().recall('A', 'what is my name?');
    expect(hits[0]?.memory.content).toBe('my name is Induj');
  });

  it('generates ids with the default generator when none is injected', async () => {
    const store = await MemoryStore.load({ embed, filePath: FILE, clock: systemClock });
    const item = await store.remember({ subject: 'A', kind: 'fact', content: 'hi' });
    expect(item.id).toMatch(/^mem_/);
  });

  it('tolerates an empty embedding result', async () => {
    const store = await MemoryStore.load(opts({ embed: () => Promise.resolve([]) }));
    const item = await store.remember({ subject: 'A', kind: 'fact', content: 'x' });
    expect(item.embedding).toEqual([]);
    expect(await store.recall('A', 'x')).toEqual([]); // query embedding is undefined
  });

  it('starts empty on a corrupt or non-array file', async () => {
    await fsp.writeFile(FILE, 'not json', 'utf8');
    expect((await MemoryStore.load(opts())).size).toBe(0);

    await fsp.writeFile(FILE, '{}', 'utf8');
    expect((await MemoryStore.load(opts())).size).toBe(0);
  });
});
