/**
 * A small, local, embedding-backed memory — enough for a personal bot without
 * standing up Postgres (which @hermes/memory requires).
 *
 * Each item is a piece of text embedded to a vector and tagged with a `subject`
 * (the Telegram chat id). `recall` embeds the query and returns the subject's
 * most similar items by cosine similarity. The same store backs two features:
 * per-chat memory (facts/preferences/past messages) and "chat with my files"
 * (document chunks ingested as items).
 *
 * Persistence is a single JSON file, loaded on start and rewritten on each
 * write. The bot processes messages one at a time, so there is no concurrent
 * writer to race. Embedding is injected (`EmbedFn`) so this is a pure,
 * network-free unit — main.ts supplies the real Ollama embedder.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Clock } from '@hermes/kernel';

export type EmbedFn = (
  texts: readonly string[],
  signal?: AbortSignal,
) => Promise<readonly (readonly number[])[]>;

export type MemoryKind = 'fact' | 'preference' | 'episode';

export interface MemoryItem {
  readonly id: string;
  readonly subject: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly createdAt: number;
}

/** Shaped to match @hermes/agent's `ScoredMemory` closely enough for its reasoner,
 *  which reads `.memory.content` and `.score`. */
export interface ScoredItem {
  readonly memory: {
    readonly id: string;
    readonly content: string;
    readonly subject: string;
    readonly kind: MemoryKind;
    readonly createdAt: number;
  };
  readonly score: number;
  readonly similarity: number;
}

export interface NewMemory {
  readonly subject: string;
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface RecallOptions {
  readonly limit?: number;
  readonly minSimilarity?: number;
}

export interface MemoryStoreOptions {
  readonly embed: EmbedFn;
  readonly filePath: string;
  readonly clock: Clock;
  /** Injected for deterministic ids in tests. Defaults to time + counter. */
  readonly nextId?: () => string;
  /**
   * Skip storing a memory whose embedding is at least this similar to an
   * existing one for the same subject (default 0.97). Keeps the store from
   * bloating with repeated near-identical messages.
   */
  readonly dedupeThreshold?: number;
}

/** Cosine similarity of two vectors, clamped to [-1, 1]; 0 for a zero vector. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  const raw = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(-1, Math.min(1, raw));
}

export class MemoryStore {
  readonly #embed: EmbedFn;
  readonly #filePath: string;
  readonly #clock: Clock;
  readonly #nextId: () => string;
  readonly #dedupeThreshold: number;
  #items: MemoryItem[] = [];
  #counter = 0;

  private constructor(options: MemoryStoreOptions, items: MemoryItem[]) {
    this.#embed = options.embed;
    this.#dedupeThreshold = options.dedupeThreshold ?? 0.97;
    this.#filePath = options.filePath;
    this.#clock = options.clock;
    this.#items = items;
    this.#nextId =
      options.nextId ??
      ((): string => {
        this.#counter += 1;
        return `mem_${String(this.#clock.now())}_${String(this.#counter)}`;
      });
  }

  /** Load the store from disk (an absent or unreadable file starts empty). */
  static async load(options: MemoryStoreOptions): Promise<MemoryStore> {
    let items: MemoryItem[] = [];
    try {
      const raw = await fsp.readFile(options.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed as MemoryItem[];
    } catch {
      // No file yet, or corrupt — start empty rather than refuse to boot.
    }
    return new MemoryStore(options, items);
  }

  get size(): number {
    return this.#items.length;
  }

  /** Distinct real subjects (chat ids) seen, excluding internal ones like docs. */
  subjects(): readonly string[] {
    return [...new Set(this.#items.map((item) => item.subject))].filter(
      (subject) => !subject.startsWith('__'),
    );
  }

  /** Embed and persist one memory (skipping a near-duplicate for the subject). */
  async remember(memory: NewMemory): Promise<MemoryItem> {
    const [embedding] = await this.#embed([memory.content]);
    const vector = embedding ?? [];

    const duplicate = this.#items.find(
      (item) =>
        item.subject === memory.subject &&
        cosineSimilarity(item.embedding, vector) >= this.#dedupeThreshold,
    );
    if (duplicate !== undefined) return duplicate;

    const item: MemoryItem = {
      id: this.#nextId(),
      subject: memory.subject,
      kind: memory.kind,
      content: memory.content,
      embedding: vector,
      createdAt: this.#clock.now(),
    };
    this.#items.push(item);
    await this.#persist();
    return item;
  }

  /** The most similar items for a subject, best first. */
  async recall(
    subject: string,
    text: string,
    options: RecallOptions = {},
  ): Promise<readonly ScoredItem[]> {
    return this.recallMany([subject], text, options);
  }

  /** The most similar items across several subjects (e.g. a chat + shared docs). */
  async recallMany(
    subjects: readonly string[],
    text: string,
    options: RecallOptions = {},
  ): Promise<readonly ScoredItem[]> {
    const wanted = new Set(subjects);
    const scoped = this.#items.filter((item) => wanted.has(item.subject));
    if (scoped.length === 0 || text.trim() === '') return [];

    const [query] = await this.#embed([text]);
    if (query === undefined) return [];

    const limit = options.limit ?? 5;
    const minSimilarity = options.minSimilarity ?? 0;

    return scoped
      .map((item): ScoredItem => {
        const similarity = cosineSimilarity(query, item.embedding);
        return {
          memory: {
            id: item.id,
            content: item.content,
            subject: item.subject,
            kind: item.kind,
            createdAt: item.createdAt,
          },
          score: similarity,
          similarity,
        };
      })
      .filter((scored) => scored.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * A read-only adapter to hand to the agent runtime (matches its MemoryAdapter).
   * `sharedSubjects` are always searched alongside the request's own subject —
   * used to fold ingested document chunks (the DOCS subject) into recall.
   */
  asMemoryAdapter(sharedSubjects: readonly string[] = []): {
    recall: (
      subject: string,
      text: string,
      options?: RecallOptions,
    ) => Promise<readonly ScoredItem[]>;
  } {
    return {
      recall: (subject, text, options) =>
        this.recallMany([subject, ...sharedSubjects], text, options),
    };
  }

  async #persist(): Promise<void> {
    await fsp.mkdir(path.dirname(this.#filePath), { recursive: true });
    await fsp.writeFile(this.#filePath, JSON.stringify(this.#items), 'utf8');
  }
}
