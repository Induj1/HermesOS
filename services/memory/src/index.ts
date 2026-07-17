/**
 * @hermes/memory — persistence and recall for HermesOS.
 *
 * The kernel refuses to know what a database is (RFC-0001 §3: "Persistence. No
 * database, no file system, no cache") and refuses to know what an embedding is.
 * This service is where both live. It depends on the kernel's public interfaces —
 * `Clock`, `Logger`, `Plugin`, the event catalogue — and on nothing internal to
 * it. The dependency runs one way, and the kernel has never heard of this package.
 *
 * It answers three questions:
 *
 *   * **What was said?**       conversation memory — verbatim, ordered, durable
 *   * **What is worth keeping?** memory records — scored, embedded, prunable
 *   * **What happened?**       mission persistence — the kernel's event stream, landed
 *
 * The intended shape of a host:
 *
 * ```ts
 * const memory = await MemoryService.create({
 *   connectionString: process.env.DATABASE_URL,
 *   embeddings: new OllamaEmbeddingProvider({ baseUrl: process.env.OLLAMA_URL }),
 *   logger,
 * });
 *
 * const runtime = Runtime.create({ concurrency: 8 });
 * runtime.use(memoryPlugin({ memory }));   // missions persist; memory.* tools registered
 * await runtime.start();
 *
 * await memory.remember({ subject: 'ada', kind: 'preference', content: 'Brief me at 07:00' });
 * const hits = await memory.recall('ada', 'when do I want my briefing?');
 * ```
 *
 * See `docs/rfcs/RFC-0002-memory.md` for why it is shaped this way.
 */

export { MemoryService } from './memory-service.js';
export type { MemoryServiceOptions, RecallOptions } from './memory-service.js';

export { memoryPlugin } from './plugin.js';
export type { MemoryPluginOptions } from './plugin.js';

export type {
  Conversation,
  ConversationId,
  MemoryId,
  MemoryKind,
  MemoryRecord,
  Message,
  MessageId,
  MessageRole,
  NewConversation,
  NewMemory,
  NewMessage,
  ScoredMemory,
  Subject,
} from './model.js';
export { MEMORY_KINDS, toConversationId, toMemoryId, toMessageId } from './model.js';

export { PgDatabase, quoteIdentifier } from './db/database.js';
export type {
  Database,
  DatabaseCapabilities,
  PgDatabaseOptions,
  Queryable,
  QueryResult,
  QueryRow,
} from './db/database.js';

export {
  appliedMigrations,
  checksumOf,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  migrate,
} from './db/migrator.js';
export type {
  AppliedMigration,
  Migration,
  MigrateOptions,
  MigrateResult,
} from './db/migrator.js';

export { ConversationRepository } from './repositories/conversation-repository.js';
export type { TranscriptOptions } from './repositories/conversation-repository.js';
export { MemoryRepository } from './repositories/memory-repository.js';
export type {
  ListMemoriesOptions,
  StoredEmbedding,
} from './repositories/memory-repository.js';
export { MissionRepository, flattenError } from './repositories/mission-repository.js';
export type {
  FlatError,
  MissionEventRecord,
  PersistedMission,
} from './repositories/mission-repository.js';

export { assertValidEmbedding, embedOne } from './embedding/provider.js';
export type { Embedding, EmbeddingProvider } from './embedding/provider.js';
export {
  fnv1a,
  HashEmbeddingProvider,
  normalise,
  tokenise,
} from './embedding/hash-embedding-provider.js';
export type { HashEmbeddingOptions } from './embedding/hash-embedding-provider.js';
export { OllamaEmbeddingProvider } from './embedding/ollama-embedding-provider.js';
export type { OllamaEmbeddingOptions } from './embedding/ollama-embedding-provider.js';

export { cosineSimilarity, DEFAULT_SEARCH_LIMIT } from './retrieval/semantic-index.js';
export type { SemanticIndex, SemanticQuery } from './retrieval/semantic-index.js';
export { createSemanticIndex } from './retrieval/create-semantic-index.js';
export type { CreateIndexOptions } from './retrieval/create-semantic-index.js';
export { PgVectorIndex, PGVECTOR_DIMENSIONS } from './retrieval/pgvector-index.js';
export { BruteForceIndex } from './retrieval/brute-force-index.js';
export type { BruteForceOptions } from './retrieval/brute-force-index.js';
export { HybridRetriever } from './retrieval/hybrid-retriever.js';
export type {
  HybridRetrieverOptions,
  RankWeights,
  RecallQuery,
} from './retrieval/hybrid-retriever.js';

export {
  clamp01,
  ConstantImportanceScorer,
  decay,
  HeuristicImportanceScorer,
  retentionScore,
} from './importance.js';
export type {
  HeuristicImportanceOptions,
  ImportanceScorer,
  ImportanceSignals,
  RetentionOptions,
} from './importance.js';

export { NeverPruneStrategy, Pruner, RetentionPruningStrategy } from './pruning.js';
export type {
  PrunedMemory,
  PrunePlan,
  PruneReason,
  PrunerOptions,
  PruningStrategy,
  RetentionPruningOptions,
} from './pruning.js';

export {
  DimensionMismatchError,
  EmbeddingFailedError,
  InvalidInputError,
  MemoryConflictError,
  MemoryError,
  MemoryNotFoundError,
  MigrationDriftError,
  MigrationFailedError,
  toError,
  UnsupportedError,
} from './errors.js';
export type { MemoryErrorCode } from './errors.js';
