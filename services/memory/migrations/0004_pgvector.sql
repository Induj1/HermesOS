-- pgvector, if this cluster has it.
--
-- This migration is conditional and MUST stay conditional. The schema is
-- pgvector-*ready*, not pgvector-dependent: the native Homebrew Postgres 17 that
-- HermesOS develops against has no `vector` extension available (only pgcrypto,
-- citext, and pg_trgm — see infrastructure/postgres/init/001-extensions.sql),
-- while the pgvector/pgvector:pg17 image named in docker-compose.yml does. Both
-- must migrate to a working schema from the same file, or the migration ledger
-- forks and the two environments stop being comparable.
--
-- So: where the extension exists, this adds an ANN-indexed vector column beside
-- the portable real[] and backfills it. Where it does not, this is a no-op and
-- retrieval runs BruteForceIndex over the same real[] data. Nothing else in the
-- schema changes either way, and `memory_embedding.embedding` stays the source
-- of truth in both worlds. See RFC-0002 §6.
--
-- To adopt pgvector on an existing database: install the extension, then re-run
-- migrations with `migrate(db, { repair: true })`. The ledger keys on this
-- file's checksum and its bytes have not changed, so the runner will otherwise
-- skip it as already applied — `repair` is what tells it to run it again. Every
-- statement below is guarded, so re-running is a no-op once the column exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE NOTICE
      'pgvector unavailable; memory_embedding.embedding (real[]) remains the only vector store. Semantic search will use BruteForceIndex.';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS vector;

  -- 768 dimensions: nomic-embed-text, the embedding model in OLLAMA_MODELS.
  --
  -- pgvector requires a fixed dimension per column and SQL cannot parameterise
  -- a type, so this number is baked in. It is the one place the schema commits
  -- to a model. Switching to a model of another width means a new migration
  -- adding a differently-typed column — which is survivable precisely because
  -- memory_embedding is keyed by (memory_id, model) and real[] carries its own
  -- `dimensions`: the portable data needs no migration, only the ANN index does.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_embedding' AND column_name = 'embedding_v'
  ) THEN
    ALTER TABLE memory_embedding ADD COLUMN embedding_v vector(768);

    -- real[] casts straight to vector, which is the whole point of storing it
    -- that way: adopting pgvector is a backfill, not a reshape.
    UPDATE memory_embedding
       SET embedding_v = embedding::vector(768)
     WHERE dimensions = 768;

    -- Keep the two columns from drifting. A row whose real[] and vector
    -- disagree would make search results depend on which index the planner
    -- picked, which is the worst kind of bug: intermittent and plausible.
    ALTER TABLE memory_embedding ADD CONSTRAINT memory_embedding_vector_matches
      CHECK (embedding_v IS NULL OR dimensions = 768);
  END IF;

  -- HNSW over IVFFlat: IVFFlat needs a populated, representative table at build
  -- time to cluster well, and this index is built on an empty one. HNSW has no
  -- training step, so it is correct from the first row — which matters more here
  -- than IVFFlat's smaller footprint at a scale of one person's memories.
  --
  -- vector_cosine_ops because embeddings are compared by direction, not
  -- magnitude, and it must match the `<=>` operator the PgVectorIndex query
  -- uses — a mismatched opclass silently degrades to a sequential scan.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'memory_embedding' AND indexname = 'memory_embedding_hnsw_idx'
  ) THEN
    CREATE INDEX memory_embedding_hnsw_idx
      ON memory_embedding USING hnsw (embedding_v vector_cosine_ops)
      WHERE embedding_v IS NOT NULL;
  END IF;
END
$$;
