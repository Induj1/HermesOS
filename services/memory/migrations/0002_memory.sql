-- Derived memory: what was worth keeping, and how to find it again.

CREATE TABLE memory_record (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Same opaque subject as conversation.subject. Every retrieval is scoped by
  -- it, so it is the leading column of every index below.
  subject                text NOT NULL CHECK (length(trim(subject)) > 0),
  kind                   text NOT NULL CHECK (
                           kind IN ('fact', 'episode', 'summary', 'preference', 'task')
                         ),
  content                text NOT NULL CHECK (length(trim(content)) > 0),

  -- Provenance. ON DELETE SET NULL rather than CASCADE: a memory outlives the
  -- conversation that produced it. Forgetting where you learned something is
  -- normal; forgetting the thing itself because the transcript was pruned is a
  -- bug.
  source_conversation_id uuid REFERENCES conversation (id) ON DELETE SET NULL,
  source_message_id      uuid REFERENCES message (id) ON DELETE SET NULL,

  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- [0,1]. Written by an ImportanceScorer, never by hand in SQL.
  importance             real NOT NULL DEFAULT 0.5
                           CHECK (importance >= 0 AND importance <= 1),
  -- Usage feedback for retention: a memory that keeps getting retrieved has
  -- proven its worth better than any scorer's guess at write time.
  access_count           integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at       timestamptz,

  -- Exempt from pruning, unconditionally. The escape hatch for "never forget
  -- this" that does not require gaming the scorer.
  pinned                 boolean NOT NULL DEFAULT false,
  -- Known-ephemeral facts ("parked in bay 14"). Pruned on expiry regardless of
  -- score, but NOT hidden from reads before then.
  expires_at             timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Soft delete. Pruning sets this; nothing else does. Reads filter on
  -- `forgotten_at IS NULL`, so a bad pruning run is recoverable by clearing a
  -- column instead of by restoring a backup. A hard sweep of long-forgotten
  -- rows is a separate, deliberate act (see PruningStrategy).
  forgotten_at           timestamptz
);

-- The scan behind every retrieval and every pruning pass: live memories for one
-- subject. Partial on forgotten_at so tombstones cost nothing to skip.
CREATE INDEX memory_record_live_idx
  ON memory_record (subject, created_at DESC)
  WHERE forgotten_at IS NULL;

-- Pruning's candidate scan: cheapest victims first.
CREATE INDEX memory_record_prunable_idx
  ON memory_record (subject, importance ASC)
  WHERE forgotten_at IS NULL AND pinned = false;

-- Expiry sweep. Partial so it indexes only the minority of rows that expire.
CREATE INDEX memory_record_expiry_idx
  ON memory_record (expires_at)
  WHERE forgotten_at IS NULL AND expires_at IS NOT NULL;

-- Lexical fallback and hybrid retrieval. pg_trgm is available everywhere the
-- init script has run, unlike pgvector — so this index is what makes retrieval
-- degrade to "worse" rather than to "nothing" on a cluster without vectors.
CREATE INDEX memory_record_content_trgm_idx
  ON memory_record USING gin (content gin_trgm_ops)
  WHERE forgotten_at IS NULL;

-- Embeddings live apart from the record they describe, for three reasons:
--   * a record can be embedded by more than one model, and re-embedding under a
--     new model must not destroy the old vector or rewrite the record;
--   * the vector is large and cold, and keeping it out of memory_record keeps
--     that table's rows small for the scans above;
--   * it makes the pgvector upgrade in 0003 a change to one narrow table.
--
-- `embedding real[]` is the portable form and the source of truth. 0003 adds a
-- pgvector column beside it where the extension exists; real[] casts straight
-- to vector, so adopting pgvector is a backfill, not a migration of the data
-- model. See RFC-0002 §6.
CREATE TABLE memory_embedding (
  memory_id   uuid NOT NULL REFERENCES memory_record (id) ON DELETE CASCADE,
  -- The model that produced this vector. Part of the key: vectors from
  -- different models share no space and must never be compared to each other.
  model       text NOT NULL CHECK (length(trim(model)) > 0),
  dimensions  integer NOT NULL CHECK (dimensions > 0),
  embedding   real[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, model),
  -- The one invariant worth paying for on every write: a vector whose length
  -- disagrees with its declared dimension is silently wrong at query time —
  -- cosine similarity against a truncated vector returns a plausible number.
  CONSTRAINT memory_embedding_dimensions_match
    CHECK (array_length(embedding, 1) = dimensions)
);

-- Brute-force search's scan: every vector for one model, joined to its record.
CREATE INDEX memory_embedding_model_idx ON memory_embedding (model);
