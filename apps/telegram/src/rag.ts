/**
 * "Chat with my files" — ingest documents into the memory store so the agent
 * can answer grounded in them.
 *
 * Documents are chunked, embedded, and stored under a single shared subject
 * (DOCS_SUBJECT), which the agent's memory adapter always searches alongside the
 * chat's own subject. Chunks are prefixed with their filename so the model can
 * cite where an answer came from. Reading the directory is the host's job
 * (main.ts) — this module is pure: it chunks text and remembers it.
 */

import type { MemoryStore } from './memory-store.js';

/** The subject under which ingested document chunks live. */
export const DOCS_SUBJECT = '__docs__';

/**
 * Split text into chunks of at most `maxChars`, preferring paragraph breaks.
 *
 * Paragraphs are packed together up to the limit; a single oversized paragraph
 * is hard-split. Keeps related sentences in one chunk so a retrieved chunk reads
 * as a coherent passage rather than a fragment.
 */
export function chunkText(text: string, maxChars = 800): readonly string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
  };

  for (const paragraph of paragraphs) {
    if (current !== '' && current.length + paragraph.length + 2 > maxChars) flush();
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  flush();
  return chunks;
}

export interface Doc {
  readonly name: string;
  readonly content: string;
}

/**
 * Ingest documents into the store under DOCS_SUBJECT. Returns the number of
 * chunks stored. Each chunk is tagged with its source filename.
 */
export async function ingestDocs(
  store: MemoryStore,
  docs: readonly Doc[],
): Promise<number> {
  let count = 0;
  for (const doc of docs) {
    for (const chunk of chunkText(doc.content)) {
      await store.remember({
        subject: DOCS_SUBJECT,
        kind: 'fact',
        content: `[${doc.name}] ${chunk}`,
      });
      count += 1;
    }
  }
  return count;
}
