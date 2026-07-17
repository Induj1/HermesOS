/**
 * Semantic retrieval, end to end.
 *
 * The interesting constraint here is that these tests must pass on **both**
 * kinds of cluster: one with pgvector and one without. `createSemanticIndex`
 * picks the implementation by probing, so on the development machine these
 * exercise `BruteForceIndex` and on a pgvector cluster they exercise
 * `PgVectorIndex` — from the same assertions. That is the property that makes
 * the fallback trustworthy rather than theoretical (RFC-0002 §6): if the two
 * implementations ever disagree about what "nearest" means, one of these fails.
 *
 * They use `HashEmbeddingProvider`, which is deterministic and knows nothing
 * about meaning — so every assertion is about *lexical* overlap, and about
 * ranking mechanics, never about a model being clever. See the provider's header.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@hermes/kernel';
import { HashEmbeddingProvider } from '../src/embedding/hash-embedding-provider.js';
import { embedOne } from '../src/embedding/provider.js';
import { ConstantImportanceScorer } from '../src/importance.js';
import type { MemoryKind, NewMemory } from '../src/model.js';
import { BruteForceIndex } from '../src/retrieval/brute-force-index.js';
import { createSemanticIndex } from '../src/retrieval/create-semantic-index.js';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever.js';
import { PgVectorIndex } from '../src/retrieval/pgvector-index.js';
import type { SemanticIndex } from '../src/retrieval/semantic-index.js';
import { UnsupportedError } from '../src/errors.js';
import { MemoryRepository } from '../src/repositories/memory-repository.js';
import {
  describeIntegration,
  truncateAll,
  withTestDatabase,
} from './helpers/database.js';

const DAY = 24 * 60 * 60 * 1000;

describeIntegration('semantic retrieval', () => {
  const test = withTestDatabase();
  // 768 to match migration 0004's vector(768), so that a pgvector-enabled
  // cluster takes the indexed path rather than silently falling back on width.
  const embeddings = new HashEmbeddingProvider({ dimensions: 768 });
  let repository: MemoryRepository;
  let index: SemanticIndex;
  let hasPgvector = false;

  beforeEach(async () => {
    await truncateAll(test.db);
    repository = new MemoryRepository(
      test.db,
      test.clock,
      new ConstantImportanceScorer(0.5),
    );
    ({ pgvector: hasPgvector } = await test.db.capabilities());
    index = await createSemanticIndex(test.db, test.clock, {
      dimensions: embeddings.dimensions,
    });
  });

  /** Store a memory and its vector, the way MemoryService.remember does. */
  async function remember(input: NewMemory): Promise<string> {
    const memory = await repository.create(input);
    const vector = await embedOne(embeddings, memory.content);
    await repository.putEmbedding(
      {
        memoryId: memory.id,
        model: embeddings.model,
        dimensions: embeddings.dimensions,
        embedding: vector,
      },
      hasPgvector,
    );
    return memory.id;
  }

  async function search(
    text: string,
    options: {
      limit?: number;
      kinds?: readonly MemoryKind[];
      minSimilarity?: number;
    } = {},
  ) {
    return index.search({
      subject: 'ada',
      embedding: await embedOne(embeddings, text),
      model: embeddings.model,
      ...options,
    });
  }

  describe('index selection', () => {
    it('picks an implementation that matches the cluster', () => {
      // The probe is the contract: configuration cannot claim pgvector that the
      // database does not have, nor miss pgvector that it does.
      expect(index.kind).toBe(hasPgvector ? 'pgvector' : 'brute-force');
    });

    it('honours forceBruteForce', async () => {
      const forced = await createSemanticIndex(test.db, test.clock, {
        forceBruteForce: true,
      });
      expect(forced.kind).toBe('brute-force');
    });

    it('falls back to brute force when the provider width does not match the column', async () => {
      // pgvector's column is vector(768). A 384-wide provider cannot use its
      // index, and must not fail — it must degrade.
      const narrow = await createSemanticIndex(test.db, test.clock, {
        dimensions: 384,
      });
      expect(narrow.kind).toBe('brute-force');
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await remember({
        subject: 'ada',
        kind: 'episode',
        content: 'The dentist appointment is on Tuesday afternoon',
      });
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Ships sail across the wide open ocean',
      });
      await remember({
        subject: 'ada',
        kind: 'preference',
        content: 'Coffee should be black with no sugar',
      });
    });

    it('ranks the relevant memory first', async () => {
      const hits = await search('when is the dentist appointment');
      expect(hits[0]?.memory.content).toMatch(/dentist appointment/);
    });

    it('returns similarity in [-1,1], best first', async () => {
      const hits = await search('dentist appointment');
      expect(hits.length).toBeGreaterThan(0);

      for (const hit of hits) {
        expect(hit.similarity).toBeGreaterThanOrEqual(-1);
        expect(hit.similarity).toBeLessThanOrEqual(1);
      }
      const scores = hits.map((hit) => hit.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('honours the limit', async () => {
      expect(await search('anything', { limit: 2 })).toHaveLength(2);
    });

    it('filters by kind', async () => {
      const hits = await search('dentist appointment', { kinds: ['preference'] });
      expect(hits.every((hit) => hit.memory.kind === 'preference')).toBe(true);
    });

    it('drops results below minSimilarity', async () => {
      // Without a floor, a search over three memories returns all three —
      // including the ones about nothing to do with the query. A retriever that
      // always returns something pads a model's context with noise.
      const unfiltered = await search('dentist appointment');
      const filtered = await search('dentist appointment', { minSimilarity: 0.5 });

      expect(filtered.length).toBeLessThan(unfiltered.length);
      expect(filtered.every((hit) => (hit.similarity ?? 0) >= 0.5)).toBe(true);
    });

    it('scopes to the subject', async () => {
      await remember({
        subject: 'grace',
        kind: 'fact',
        content: 'dentist appointment secret',
      });

      const hits = await search('dentist appointment');
      expect(hits.every((hit) => hit.memory.subject === 'ada')).toBe(true);
    });

    it('excludes forgotten memories', async () => {
      const hits = await search('dentist appointment');
      const target = hits[0]?.memory.id;
      await repository.forget([target as never]);

      const after = await search('dentist appointment');
      expect(after.map((hit) => hit.memory.id)).not.toContain(target);
    });

    it('excludes expired memories unless asked', async () => {
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Parked in bay fourteen today only',
        expiresAt: test.clock.now() - 1,
      });

      const hidden = await search('parked in bay fourteen');
      expect(hidden.map((h) => h.memory.content)).not.toContain(
        'Parked in bay fourteen today only',
      );

      const shown = await search('parked in bay fourteen', {
        includeExpired: true,
      } as never);
      expect(shown.map((h) => h.memory.content)).toContain(
        'Parked in bay fourteen today only',
      );
    });

    it('ignores vectors from another model', async () => {
      // Vectors from different models occupy unrelated spaces; comparing them
      // returns a number, and the number is meaningless. This is why every query
      // filters on model.
      const other = new HashEmbeddingProvider({
        dimensions: 768,
        model: 'other-model',
      });
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Only embedded under another model entirely',
      });
      await repository.putEmbedding(
        {
          memoryId: memory.id,
          model: other.model,
          dimensions: 768,
          embedding: await embedOne(other, memory.content),
        },
        hasPgvector,
      );

      const hits = await search('only embedded under another model entirely');
      expect(hits.map((hit) => hit.memory.id)).not.toContain(memory.id);
    });

    it('returns nothing when the subject has no memories', async () => {
      const hits = await index.search({
        subject: 'nobody',
        embedding: await embedOne(embeddings, 'anything'),
        model: embeddings.model,
      });
      expect(hits).toEqual([]);
    });

    it('ignores a memory with no vector', async () => {
      const bare = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Never embedded at all',
      });
      const hits = await search('never embedded at all');
      expect(hits.map((hit) => hit.memory.id)).not.toContain(bare.id);
    });
  });

  describe('BruteForceIndex specifically', () => {
    it('agrees with the configured index on ordering', async () => {
      // On a pgvector cluster this compares the two implementations directly:
      // they must rank the same corpus the same way, or the fallback is not a
      // fallback but a different product.
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'The dentist appointment is Tuesday',
      });
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Ships sail the open ocean',
      });
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'A dentist called about Tuesday',
      });

      const brute = new BruteForceIndex(test.db, test.clock);
      const query = {
        subject: 'ada',
        embedding: await embedOne(embeddings, 'dentist tuesday'),
        model: embeddings.model,
      };

      const fromBrute = await brute.search(query);
      const fromIndex = await index.search(query);

      expect(fromBrute.map((hit) => hit.memory.id)).toEqual(
        fromIndex.map((hit) => hit.memory.id),
      );
      for (const [i, hit] of fromBrute.entries()) {
        // pgvector computes cosine in C and this computes it in JS; they agree
        // to float precision, not bit-for-bit.
        expect(hit.similarity).toBeCloseTo(fromIndex[i]?.similarity ?? NaN, 5);
      }
    });

    it('is width-agnostic, unlike the pgvector column', async () => {
      const narrow = new HashEmbeddingProvider({ dimensions: 64 });
      const memory = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'Narrow vector',
      });
      await repository.putEmbedding(
        {
          memoryId: memory.id,
          model: narrow.model,
          dimensions: 64,
          embedding: await embedOne(narrow, memory.content),
        },
        hasPgvector,
      );

      const hits = await new BruteForceIndex(test.db, test.clock).search({
        subject: 'ada',
        embedding: await embedOne(narrow, 'narrow vector'),
        model: narrow.model,
      });
      expect(hits[0]?.memory.id).toBe(memory.id);
    });

    it('warns and truncates rather than reading an unbounded set', async () => {
      // The ceiling is a bound on the damage, not a tuning knob: crossing it
      // means results are silently incomplete, so it must say so.
      const warnings: string[] = [];
      const logger = {
        ...noopLogger,
        warn: (message: string) => warnings.push(message),
        child: () => logger,
      };

      for (let i = 0; i < 3; i++) {
        await remember({
          subject: 'ada',
          kind: 'fact',
          content: `Memory number ${String(i)}`,
        });
      }

      const capped = new BruteForceIndex(test.db, test.clock, {
        maxCandidates: 2,
        logger,
      });
      const hits = await capped.search({
        subject: 'ada',
        embedding: await embedOne(embeddings, 'memory number'),
        model: embeddings.model,
      });

      expect(hits.length).toBeLessThanOrEqual(2);
      expect(warnings[0]).toMatch(/truncated.*Install pgvector/);
    });

    it('does not warn when the candidate set exactly fills the ceiling', async () => {
      // maxCandidates + 1 is fetched precisely so that "we hit the ceiling" is
      // distinguishable from "there were exactly that many". Without it, a
      // subject with exactly N memories would warn on every query, forever.
      const warnings: string[] = [];
      const logger = {
        ...noopLogger,
        warn: (m: string) => warnings.push(m),
        child: () => logger,
      };

      await remember({ subject: 'ada', kind: 'fact', content: 'One' });
      await remember({ subject: 'ada', kind: 'fact', content: 'Two' });

      await new BruteForceIndex(test.db, test.clock, {
        maxCandidates: 2,
        logger,
      }).search({
        subject: 'ada',
        embedding: await embedOne(embeddings, 'one two'),
        model: embeddings.model,
      });

      expect(warnings).toEqual([]);
    });
  });

  describe('PgVectorIndex specifically', () => {
    it.skipIf(!hasPgvector)(
      'rejects a query of the wrong width, naming the fix',
      async () => {
        const wrong = new PgVectorIndex(test.db, test.clock);
        await expect(
          wrong.search({
            subject: 'ada',
            embedding: [1, 2, 3],
            model: embeddings.model,
          }),
        ).rejects.toThrow(UnsupportedError);
      },
    );
  });

  describe('HybridRetriever', () => {
    it('ranks a similar memory above a dissimilar one', async () => {
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'The dentist appointment is Tuesday',
      });
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'Ships sail the open ocean',
      });

      const retriever = new HybridRetriever(index, repository);
      const hits = await retriever.recall(
        {
          subject: 'ada',
          text: 'dentist appointment',
          embedding: await embedOne(embeddings, 'dentist appointment'),
          model: embeddings.model,
        },
        test.clock.now(),
      );

      expect(hits[0]?.memory.content).toMatch(/dentist/);
    });

    it('scores within [0,1]', async () => {
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'The dentist appointment is Tuesday',
      });

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          text: 'dentist',
          embedding: await embedOne(embeddings, 'dentist'),
          model: embeddings.model,
        },
        test.clock.now(),
      );

      for (const hit of hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    });

    it('lets importance break a tie between equally similar memories', async () => {
      // The reason ranking is not just cosine: the nearest memory is often a
      // stale episode that shares vocabulary, while the standing preference that
      // governs the answer sits below it.
      const boring = await repository.create({
        subject: 'ada',
        kind: 'episode',
        content: 'Coffee was mentioned once in passing',
        importance: 0.05,
      });
      const vital = await repository.create({
        subject: 'ada',
        kind: 'preference',
        content: 'Coffee was mentioned once in passing',
        importance: 0.95,
      });
      for (const id of [boring.id, vital.id]) {
        await repository.putEmbedding(
          {
            memoryId: id,
            model: embeddings.model,
            dimensions: 768,
            embedding: await embedOne(
              embeddings,
              'Coffee was mentioned once in passing',
            ),
          },
          hasPgvector,
        );
      }

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          text: 'coffee',
          embedding: await embedOne(embeddings, 'coffee'),
          model: embeddings.model,
        },
        test.clock.now(),
      );

      expect(hits[0]?.memory.id).toBe(vital.id);
    });

    it('finds an exact token the embedding blurs, via the lexical arm', async () => {
      // What the hybrid buys. A pure vector search over names and ids is exactly
      // where embeddings are weakest.
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'The car is parked in bay B14 today',
      });
      for (let i = 0; i < 5; i++) {
        await remember({
          subject: 'ada',
          kind: 'fact',
          content: `Unrelated filler memory ${String(i)}`,
        });
      }

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          text: 'bay B14',
          embedding: await embedOne(embeddings, 'bay B14'),
          model: embeddings.model,
          limit: 3,
        },
        test.clock.now(),
      );

      expect(hits.map((hit) => hit.memory.content)).toContain(
        'The car is parked in bay B14 today',
      );
    });

    it('deduplicates a memory found by both arms', async () => {
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'The dentist appointment is Tuesday',
      });

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          text: 'The dentist appointment is Tuesday',
          embedding: await embedOne(embeddings, 'The dentist appointment is Tuesday'),
          model: embeddings.model,
        },
        test.clock.now(),
      );

      expect(new Set(hits.map((hit) => hit.memory.id)).size).toBe(hits.length);
    });

    it('prefers a fresh memory over a stale identical one', async () => {
      const stale = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'The status is green',
        importance: 0.5,
      });
      await test.clock.advance(400 * DAY);
      const fresh = await repository.create({
        subject: 'ada',
        kind: 'fact',
        content: 'The status is green',
        importance: 0.5,
      });
      for (const id of [stale.id, fresh.id]) {
        await repository.putEmbedding(
          {
            memoryId: id,
            model: embeddings.model,
            dimensions: 768,
            embedding: await embedOne(embeddings, 'The status is green'),
          },
          hasPgvector,
        );
      }

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          text: 'status',
          embedding: await embedOne(embeddings, 'status'),
          model: embeddings.model,
        },
        test.clock.now(),
      );

      expect(hits[0]?.memory.id).toBe(fresh.id);
    });

    it('honours the limit after re-ranking', async () => {
      for (let i = 0; i < 10; i++) {
        await remember({
          subject: 'ada',
          kind: 'fact',
          content: `Memory about topic ${String(i)}`,
        });
      }

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          text: 'topic',
          embedding: await embedOne(embeddings, 'topic'),
          model: embeddings.model,
          limit: 3,
        },
        test.clock.now(),
      );

      expect(hits).toHaveLength(3);
    });

    it('works with no query text, as a pure semantic search', async () => {
      await remember({
        subject: 'ada',
        kind: 'fact',
        content: 'The dentist appointment is Tuesday',
      });

      const hits = await new HybridRetriever(index, repository).recall(
        {
          subject: 'ada',
          embedding: await embedOne(embeddings, 'dentist'),
          model: embeddings.model,
        },
        test.clock.now(),
      );

      expect(hits.length).toBeGreaterThan(0);
    });

    it('is deterministic across repeated calls', async () => {
      // The tiebreak exists because Map iteration order depends on which arm
      // returned first — non-deterministic, and exactly what makes a flaky test
      // look like a real bug.
      for (let i = 0; i < 5; i++) {
        await remember({
          subject: 'ada',
          kind: 'fact',
          content: `Memory about topic ${String(i)}`,
        });
      }
      const retriever = new HybridRetriever(index, repository);
      const query = {
        subject: 'ada',
        text: 'topic',
        embedding: await embedOne(embeddings, 'topic'),
        model: embeddings.model,
      };

      const first = await retriever.recall(query, test.clock.now());
      for (let i = 0; i < 3; i++) {
        const again = await retriever.recall(query, test.clock.now());
        expect(again.map((hit) => hit.memory.id)).toEqual(
          first.map((hit) => hit.memory.id),
        );
      }
    });

    it('respects custom weights', async () => {
      // Weights are defaults, not truths. Turning similarity off entirely must
      // change the ranking, or they are not wired up.
      const relevant = await repository.create({
        subject: 'ada',
        kind: 'episode',
        content: 'dentist appointment tuesday',
        importance: 0.01,
      });
      const important = await repository.create({
        subject: 'ada',
        kind: 'preference',
        content: 'ships sail oceans widely',
        importance: 0.99,
      });
      for (const memory of [relevant, important]) {
        await repository.putEmbedding(
          {
            memoryId: memory.id,
            model: embeddings.model,
            dimensions: 768,
            embedding: await embedOne(embeddings, memory.content),
          },
          hasPgvector,
        );
      }

      const query = {
        subject: 'ada',
        embedding: await embedOne(embeddings, 'dentist appointment tuesday'),
        model: embeddings.model,
      };

      const bySimilarity = new HybridRetriever(index, repository);
      expect((await bySimilarity.recall(query, test.clock.now()))[0]?.memory.id).toBe(
        relevant.id,
      );

      const byImportance = new HybridRetriever(index, repository, {
        weights: { similarity: 0, importance: 1, recency: 0, usage: 0 },
      });
      expect((await byImportance.recall(query, test.clock.now()))[0]?.memory.id).toBe(
        important.id,
      );
    });
  });
});
