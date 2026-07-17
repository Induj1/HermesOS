-- Conversation memory: the raw record of what was said.
--
-- This is the bottom of the memory stack and the only part that is verbatim.
-- Everything above it (memory_record in 0002) is derived, lossy, and prunable;
-- a conversation is none of those things. Keep that distinction: if a future
-- change wants to summarise-in-place or delete old messages to save space, it
-- wants a memory_record, not this table.

CREATE TABLE conversation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who this conversation is with, from the host's point of view: a Telegram
  -- chat id, a user id, "cli". Opaque here on purpose — the memory service has
  -- no user model and must not grow one.
  subject          text NOT NULL CHECK (length(trim(subject)) > 0),
  title            text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Monotonic counter, incremented under the row lock taken by the appending
  -- transaction. This is how a message gets its `seq` without a race: two
  -- concurrent appends to one conversation serialise on this UPDATE, so they
  -- cannot both read the same MAX(seq) and collide. A sequence would be wrong
  -- here — it is global and gappy, and `seq` must be dense per conversation.
  message_count    bigint NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);

-- The dominant read: "the open conversation for this subject, most recent
-- first". Partial on closed_at IS NULL because closed conversations are read by
-- id, never scanned for.
CREATE INDEX conversation_subject_open_idx
  ON conversation (subject, updated_at DESC)
  WHERE closed_at IS NULL;

CREATE TABLE message (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  -- Dense, 1-based, per conversation. Ordering is by seq and never by
  -- created_at: two messages can share a millisecond, and a stable transcript
  -- order matters more than clock precision.
  seq              bigint NOT NULL CHECK (seq > 0),
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content          text NOT NULL,
  -- Tool calls, token counts, model name, whatever the host wants to carry.
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

-- Paging a transcript backwards ("last N messages") is the hot path, and the
-- UNIQUE constraint's index above is ascending. This serves the DESC scan
-- without a sort.
CREATE INDEX message_conversation_recent_idx
  ON message (conversation_id, seq DESC);
