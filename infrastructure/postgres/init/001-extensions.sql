-- Cluster-level setup that must exist before the first migration runs.
--
-- Applied two ways, so every statement must be idempotent:
--   * natively, by `just db-init` — re-runs on every invocation
--   * in the `containerized` profile, once, on first boot of an empty volume
--     (re-trigger with `just docker-reset`, which destroys that volume's data)
--
-- Schema changes do NOT belong here — use a migration.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS "citext";        -- case-insensitive text (emails)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- trigram fuzzy search

-- Vector search for embeddings. Requires the pgvector/pgvector:pg17 image;
-- uncomment together with the POSTGRES_VERSION swap in .env.
-- CREATE EXTENSION IF NOT EXISTS "vector";
