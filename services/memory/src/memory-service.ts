/**
 * MemoryService — the composition root and the public entry point.
 *
 * Everything below this file is independently usable: the repositories work
 * without the retriever, the retriever without the pruner, the scorer without
 * any of it. This is the assembled default, so that a host writes one `create`
 * call rather than wiring six objects and getting the clock wrong in one of them.
 *
 * The dependencies it takes are the kernel's public interfaces — `Clock`,
 * `Logger` — and nothing else from the kernel. There is no import of a kernel
 * internal here or anywhere in this package (RFC-0002 §3).
 */

import type { Clock, Logger } from '@hermes/kernel';
import { noopLogger, systemClock } from '@hermes/kernel';
import { PgDatabase, type Database } from './db/database.js';
import { migrate, type MigrateResult } from './db/migrator.js';
import { embedOne, type EmbeddingProvider } from './embedding/provider.js';
import { HashEmbeddingProvider } from './embedding/hash-embedding-provider.js';
import { toError } from './errors.js';
import { HeuristicImportanceScorer, type ImportanceScorer } from './importance.js';
import type {
  Conversation,
  ConversationId,
  MemoryKind,
  MemoryRecord,
  Message,
  NewConversation,
  NewMemory,
  NewMessage,
  ScoredMemory,
  Subject,
} from './model.js';
import { Pruner, type PrunePlan, type PruningStrategy } from './pruning.js';
import { ConversationRepository } from './repositories/conversation-repository.js';
import { MemoryRepository } from './repositories/memory-repository.js';
import { MissionRepository } from './repositories/mission-repository.js';
import { createSemanticIndex } from './retrieval/create-semantic-index.js';
import { HybridRetriever, type RankWeights } from './retrieval/hybrid-retriever.js';
import type { SemanticIndex } from './retrieval/semantic-index.js';

export interface MemoryServiceOptions {
  /** libpq connection string. From DATABASE_URL; never read from env here. */
  readonly connectionString?: string;
  /** An already-built database. Mutually exclusive with `connectionString`. */
  readonly database?: Database;
  /** Head of the search_path. The isolation unit for tests. */
  readonly schema?: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Defaults to {@link HashEmbeddingProvider} — offline, deterministic, not smart. */
  readonly embeddings?: EmbeddingProvider;
  readonly scorer?: ImportanceScorer;
  readonly pruningStrategy?: PruningStrategy;
  readonly weights?: RankWeights;
  /** Run migrations on `create`. Default true. */
  readonly migrateOnStart?: boolean;
}

export interface RecallOptions {
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
  readonly minSimilarity?: number;
  readonly includeExpired?: boolean;
}

export class MemoryService {
  readonly conversations: ConversationRepository;
  readonly memories: MemoryRepository;
  readonly missions: MissionRepository;
  readonly db: Database;
  readonly embeddings: EmbeddingProvider;
  readonly index: SemanticIndex;
  readonly pruner: Pruner;

  readonly #retriever: HybridRetriever;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #ownsDatabase: boolean;
  #hasPgvector: boolean;

  private constructor(init: {
    db: Database;
    clock: Clock;
    logger: Logger;
    embeddings: EmbeddingProvider;
    scorer: ImportanceScorer;
    index: SemanticIndex;
    hasPgvector: boolean;
    ownsDatabase: boolean;
    strategy: PruningStrategy | undefined;
    weights: RankWeights | undefined;
  }) {
    this.db = init.db;
    this.#clock = init.clock;
    this.#logger = init.logger;
    this.embeddings = init.embeddings;
    this.index = init.index;
    this.#hasPgvector = init.hasPgvector;
    this.#ownsDatabase = init.ownsDatabase;

    this.conversations = new ConversationRepository(init.db, init.clock);
    this.memories = new MemoryRepository(init.db, init.clock, init.scorer);
    this.missions = new MissionRepository(init.db);
    this.#retriever = new HybridRetriever(init.index, this.memories, {
      ...(init.weights === undefined ? {} : { weights: init.weights }),
    });
    this.pruner = new Pruner(this.memories, init.clock, {
      logger: init.logger,
      ...(init.strategy === undefined ? {} : { strategy: init.strategy }),
    });
  }

  /**
   * Build the service: connect, migrate, probe, wire.
   *
   * Async because two of those steps are, and because the alternative — a
   * synchronous constructor plus an `init()` a caller can forget — produces an
   * object that is a valid `MemoryService` but throws on every method.
   */
  static async create(options: MemoryServiceOptions = {}): Promise<MemoryService> {
    const clock = options.clock ?? systemClock;
    const logger = options.logger ?? noopLogger;
    const embeddings = options.embeddings ?? new HashEmbeddingProvider();

    if (options.database && options.connectionString !== undefined) {
      throw new TypeError(
        'Pass either `database` or `connectionString`, not both: the connection string would be ignored.',
      );
    }

    // An if/else chain rather than `options.database ?? new PgDatabase(...)`,
    // because this shape is what narrows `connectionString` to a string. The
    // terser version needs a non-null assertion to say the same thing, and an
    // assertion is a claim the compiler cannot check — here the compiler can.
    let db: Database;
    let ownsDatabase: boolean;

    if (options.database) {
      db = options.database;
      // A caller's database is theirs: they close it, not us.
      ownsDatabase = false;
    } else if (options.connectionString !== undefined) {
      db = new PgDatabase({
        connectionString: options.connectionString,
        ...(options.schema === undefined ? {} : { schema: options.schema }),
      });
      ownsDatabase = true;
    } else {
      throw new TypeError(
        'MemoryService.create needs a `connectionString` or a `database`.',
      );
    }

    try {
      if (options.migrateOnStart !== false) {
        await migrate(db, { logger });
      }

      const index = await createSemanticIndex(db, clock, {
        logger,
        dimensions: embeddings.dimensions,
      });
      const { pgvector } = await db.capabilities();

      return new MemoryService({
        db,
        clock,
        logger,
        embeddings,
        scorer: options.scorer ?? new HeuristicImportanceScorer(),
        index,
        hasPgvector: pgvector,
        ownsDatabase,
        strategy: options.pruningStrategy,
        weights: options.weights,
      });
    } catch (thrown) {
      // A pool built here and abandoned on a failed migration keeps the process
      // alive with open handles — the classic "tests hang after a failure".
      // Only close what we opened; a caller-supplied database is theirs.
      if (ownsDatabase) await db.close().catch(() => undefined);
      throw thrown;
    }
  }

  /**
   * Store a memory and embed it.
   *
   * ## Why embedding failure does not fail the write
   *
   * The record is committed first, then embedded. If the embedding provider is
   * down — Ollama not running, model not pulled — the memory is still stored,
   * and the failure is logged rather than thrown.
   *
   * That is deliberate. The alternative is that a local model being unavailable
   * means Hermes silently stops remembering anything, which is a far worse
   * failure than degraded recall: the memory is unrecoverable, whereas an
   * un-embedded memory is still found by lexical search and can be embedded
   * later. `MemoryRepository.findUnembedded` exists precisely to find these, and
   * `backfillEmbeddings` is the repair.
   */
  async remember(input: NewMemory): Promise<MemoryRecord> {
    const memory = await this.memories.create(input);

    try {
      const vector = await embedOne(this.embeddings, memory.content);
      await this.memories.putEmbedding(
        {
          memoryId: memory.id,
          model: this.embeddings.model,
          dimensions: this.embeddings.dimensions,
          embedding: vector,
        },
        this.#hasPgvector,
      );
    } catch (thrown) {
      this.#logger.warn(
        'Stored memory without an embedding; it will be findable lexically but not semantically. Run backfillEmbeddings once the provider is healthy.',
        {
          memoryId: memory.id,
          model: this.embeddings.model,
          error: toError(thrown).message,
        },
      );
    }

    return memory;
  }

  /**
   * Retrieve memories relevant to `text`.
   *
   * Embeds the query, runs the hybrid retriever, and records the access.
   *
   * The `touch` is fire-and-forget on purpose: it is a write on a read path, and
   * usage bookkeeping must never add latency to — or fail — a retrieval. Losing
   * one increment costs a rounding error in a ranking weight.
   */
  async recall(
    subject: Subject,
    text: string,
    options: RecallOptions = {},
  ): Promise<readonly ScoredMemory[]> {
    const embedding = await embedOne(this.embeddings, text);

    const results = await this.#retriever.recall(
      {
        subject,
        text,
        embedding,
        model: this.embeddings.model,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
        ...(options.minSimilarity === undefined
          ? {}
          : { minSimilarity: options.minSimilarity }),
        ...(options.includeExpired === undefined
          ? {}
          : { includeExpired: options.includeExpired }),
      },
      this.#clock.now(),
    );

    if (results.length > 0) {
      void this.memories
        .touch(results.map((result) => result.memory.id))
        .catch((thrown: unknown) => {
          this.#logger.debug('Failed to record memory access', {
            error: toError(thrown).message,
          });
        });
    }

    return results;
  }

  /** Embed memories that have no vector under the current model. The repair path. */
  async backfillEmbeddings(subject: Subject, limit = 100): Promise<number> {
    const pending = await this.memories.findUnembedded(
      subject,
      this.embeddings.model,
      limit,
    );
    if (pending.length === 0) return 0;

    // One batch call, not one per memory: every real provider is batch-shaped,
    // and this is the path that runs after an outage, when there is a backlog.
    const vectors = await this.embeddings.embed(
      pending.map((memory) => memory.content),
    );

    let written = 0;
    for (const [index, memory] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) continue;
      await this.memories.putEmbedding(
        {
          memoryId: memory.id,
          model: this.embeddings.model,
          dimensions: this.embeddings.dimensions,
          embedding: vector,
        },
        this.#hasPgvector,
      );
      written++;
    }

    this.#logger.info('Backfilled embeddings', {
      subject,
      written,
      model: this.embeddings.model,
    });
    return written;
  }

  // --- conversation sugar -------------------------------------------------

  /** Continue the open conversation for a subject, or start one. */
  async openConversation(input: NewConversation): Promise<Conversation> {
    const existing = await this.conversations.findOpenBySubject(input.subject);
    return existing ?? this.conversations.create(input);
  }

  async appendMessage(
    conversationId: ConversationId,
    message: NewMessage,
  ): Promise<Message> {
    return this.conversations.appendMessage(conversationId, message);
  }

  /** The last N messages, oldest-first: the shape a model's context window wants. */
  async context(
    conversationId: ConversationId,
    limit = 20,
  ): Promise<readonly Message[]> {
    return this.conversations.transcript(conversationId, { limit, order: 'asc' });
  }

  // --- lifecycle ----------------------------------------------------------

  async prune(subject: Subject): Promise<PrunePlan> {
    return this.pruner.prune(subject);
  }

  async migrate(): Promise<MigrateResult> {
    const result = await migrate(this.db, { logger: this.#logger });
    // Migrating can install pgvector's column, which changes what `putEmbedding`
    // should write. `refresh` is required, not incidental: capabilities are
    // cached, so a stale `false` would otherwise keep this service writing NULL
    // vectors for the rest of the process's life after the upgrade that was
    // meant to fix exactly that.
    const { pgvector } = await this.db.capabilities({ refresh: true });
    this.#hasPgvector = pgvector;
    return result;
  }

  /** Close the pool, if this service opened it. A caller's database is theirs to close. */
  async close(): Promise<void> {
    if (this.#ownsDatabase) await this.db.close();
  }
}
