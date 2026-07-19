import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemClock } from '@hermes/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { DOCS_SUBJECT, chunkText, htmlToText, ingestDocs } from '../src/rag.js';

describe('htmlToText', () => {
  it('drops script/style, tags, and entities', () => {
    const html =
      '<html><head><style>.a{}</style></head><body><script>x=1</script>' +
      '<h1>Hi &amp; bye</h1><p>Some&nbsp;text</p></body></html>';
    expect(htmlToText(html)).toBe('Hi & bye Some text');
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });

  it('returns nothing for blank text', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('packs paragraphs up to the limit', () => {
    const text = 'a'.repeat(30) + '\n\n' + 'b'.repeat(30);
    expect(chunkText(text, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)]);
  });

  it('hard-splits a single oversized paragraph', () => {
    const chunks = chunkText('x'.repeat(50), 20);
    expect(chunks).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)]);
  });
});

describe('ingestDocs', () => {
  const FILE = path.join(os.tmpdir(), 'hermes-rag-test.json');
  const embed = (texts: readonly string[]) =>
    Promise.resolve(texts.map((t) => [t.length, t.includes('coffee') ? 1 : 0]));

  beforeEach(async () => {
    await fsp.rm(FILE, { force: true });
  });
  afterEach(async () => {
    await fsp.rm(FILE, { force: true });
  });

  it('chunks and stores docs under the docs subject, tagged by filename', async () => {
    const store = await MemoryStore.load({ embed, filePath: FILE, clock: systemClock });
    // Two short paragraphs pack into one chunk under the default limit.
    const count = await ingestDocs(store, [
      { name: 'notes.md', content: 'I love coffee.\n\nI live in Bengaluru.' },
      { name: 'big.md', content: 'y'.repeat(2000) },
    ]);

    expect(count).toBe(4); // notes.md: 1 chunk; big.md: 3 chunks (2000 / 800)
    const hits = await store.recall(DOCS_SUBJECT, 'coffee', { limit: 5 });
    expect(hits.some((h) => h.memory.content.startsWith('[notes.md]'))).toBe(true);
  });
});
