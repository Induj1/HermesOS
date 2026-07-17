/**
 * Ranking: turning "similar" into "worth showing".
 *
 * A pure semantic index answers "what is closest to this query vector", which is
 * not the same question as "what should this agent be told". The gap is where
 * assistants disappoint: the nearest memory is often a stale episode that
 * happens to share vocabulary, while the standing preference that actually
 * governs the answer sits three places down.
 *
 * So the final rank blends four signals:
 *
 *   similarity  how close the vectors are          — the semantic index
 *   importance  what the memory is worth           — the ImportanceScorer
 *   recency     how fresh it is                    — exponential decay
 *   usage       how often it has proven useful     — access_count
 *
 * The weights are defaults, not truths. They are exposed on the constructor and
 * are the first thing to tune when recall feels wrong — see RFC-0002 §8.
 *
 * The retriever also unions in lexical (pg_trgm) hits, which is what makes recall
 * work at all for exact tokens an embedding smooths away: names, ids, "bay 14".
 */

import type { MemoryRepository } from '../repositories/memory-repository.js';
import { clamp01, decay } from '../importance.js';
import type { MemoryId, ScoredMemory } from '../model.js';
import type { SemanticIndex, SemanticQuery } from './semantic-index.js';
import { DEFAULT_SEARCH_LIMIT } from './semantic-index.js';

export interface RankWeights {
  readonly similarity?: number;
  readonly importance?: number;
  readonly recency?: number;
  readonly usage?: number;
  /** Age at which recency halves, in ms. Default 30 days. */
  readonly halfLifeMs?: number;
}

const DEFAULT_WEIGHTS: Required<RankWeights> = {
  // Similarity dominates, and should: the caller asked about something specific,
  // and a retriever that returns important-but-irrelevant memories is worse than
  // useless — it is confidently off-topic. The other three break ties among
  // things that are already relevant, which is the only job they should have.
  similarity: 0.6,
  importance: 0.2,
  recency: 0.15,
  usage: 0.05,
  halfLifeMs: 30 * 24 * 60 * 60 * 1000,
};

export interface RecallQuery extends SemanticQuery {
  /**
   * The original query text, for the lexical arm.
   *
   * Optional: without it the retriever is purely semantic. With it, exact tokens
   * an embedding blurs — a name, an id, a number — can still match. Passing it is
   * almost always right.
   */
  readonly text?: string;
}

export interface HybridRetrieverOptions {
  readonly weights?: RankWeights;
  /**
   * How many candidates to pull from each arm before ranking. Default 4× limit.
   *
   * Over-fetching is what makes the blend mean anything: if each arm returned
   * exactly `limit`, re-ranking could only reorder what similarity already chose,
   * and an important memory ranked 11th by cosine could never surface.
   */
  readonly candidateFactor?: number;
  /** Weight applied to lexical (trigram) similarity relative to semantic. Default 0.7. */
  readonly lexicalWeight?: number;
}

export class HybridRetriever {
  readonly #index: SemanticIndex;
  readonly #memories: MemoryRepository;
  readonly #weights: Required<RankWeights>;
  readonly #candidateFactor: number;
  readonly #lexicalWeight: number;

  constructor(
    index: SemanticIndex,
    memories: MemoryRepository,
    options: HybridRetrieverOptions = {},
  ) {
    this.#index = index;
    this.#memories = memories;
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.#candidateFactor = options.candidateFactor ?? 4;
    this.#lexicalWeight = options.lexicalWeight ?? 0.7;
  }

  async recall(query: RecallQuery, now: number): Promise<readonly ScoredMemory[]> {
    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
    const candidateLimit = limit * this.#candidateFactor;

    // Both arms concurrently: they hit different indexes and neither depends on
    // the other, so the round trips overlap.
    const [semantic, lexical] = await Promise.all([
      this.#index.search({ ...query, limit: candidateLimit }),
      this.#lexical(query, candidateLimit),
    ]);

    // Union by id, keeping the better similarity. A memory found by both arms is
    // the strongest kind of hit — it matches in meaning *and* in words — and
    // taking the max lets it be ranked on whichever arm was more confident,
    // rather than being penalised by the weaker one.
    const merged = new Map<MemoryId, ScoredMemory>();
    for (const hit of [...semantic, ...lexical]) {
      const existing = merged.get(hit.memory.id);
      if (!existing || (hit.similarity ?? 0) > (existing.similarity ?? 0)) {
        merged.set(hit.memory.id, hit);
      }
    }

    const ranked = [...merged.values()]
      .map((hit) => ({
        memory: hit.memory,
        similarity: hit.similarity,
        score: this.#rank(hit, now),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          // A stable tiebreak, so equal scores do not reorder between calls.
          // Map iteration order is insertion order, which depends on which arm
          // returned first — non-deterministic, and exactly the kind of thing
          // that makes a flaky test look like a real bug.
          b.memory.createdAt - a.memory.createdAt ||
          a.memory.id.localeCompare(b.memory.id),
      );

    return ranked.slice(0, limit);
  }

  async #lexical(query: RecallQuery, limit: number): Promise<readonly ScoredMemory[]> {
    if (query.text === undefined || query.text.trim().length === 0) return [];
    const hits = await this.#memories.search(query.subject, query.text, limit);
    return hits
      .filter(
        (hit) => query.kinds === undefined || query.kinds.includes(hit.memory.kind),
      )
      .map((hit) => ({
        memory: hit.memory,
        // Trigram similarity and cosine similarity are both "1 is identical, 0 is
        // unrelated" but are not the same measurement, and trigram scores run
        // systematically higher for short strings. The discount stops a lexical
        // near-miss from outranking a genuine semantic match.
        similarity: hit.similarity * this.#lexicalWeight,
        score: hit.similarity * this.#lexicalWeight,
      }));
  }

  #rank(hit: ScoredMemory, now: number): number {
    const { similarity, importance, recency, usage, halfLifeMs } = this.#weights;
    const memory = hit.memory;

    // Cosine is in [-1,1] and every other signal is in [0,1]. Mapped rather than
    // clamped: clamping would make every orthogonal-or-worse memory score
    // identically at 0, collapsing a real ordering among weak matches.
    const similarityScore = ((hit.similarity ?? 0) + 1) / 2;

    const touchedAt = memory.lastAccessedAt ?? memory.createdAt;
    const recencyScore = decay(now - touchedAt, halfLifeMs);
    const usageScore = memory.accessCount / (memory.accessCount + 5);

    const total = similarity + importance + recency + usage;
    if (total <= 0) return 0;

    return clamp01(
      (similarityScore * similarity +
        memory.importance * importance +
        recencyScore * recency +
        usageScore * usage) /
        total,
    );
  }
}
