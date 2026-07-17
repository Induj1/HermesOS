-- Mission persistence: the kernel's event stream, landed.
--
-- The kernel is in-memory and loses everything on restart (RFC-0001 §11.2). Its
-- seam for persistence is the event stream — every event carries a plain,
-- serialisable snapshot — so these tables are a projection of that stream, not
-- a second source of truth. The kernel does not read them and must never learn
-- they exist.
--
-- Ids are `text`, not `uuid`: MissionId and TaskId are branded strings whose
-- shape the kernel explicitly derives no meaning from (kernel ids.ts). Storing
-- them as uuid would import an assumption the kernel refuses to make and would
-- break the moment someone injects sequentialIds() — which the kernel ships and
-- which produces `mission_1`.

CREATE TABLE mission (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  goal           text,
  state          text NOT NULL CHECK (
                   state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
                 ),
  failure_policy text NOT NULL CHECK (failure_policy IN ('fail-fast', 'continue')),
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- From the snapshot's epoch-millisecond fields, not from now(). The kernel's
  -- clock is injectable and a TestClock starts at 0; recording wall time here
  -- would make persisted history disagree with the kernel that produced it.
  created_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  -- Wall time of the write. The one honest use of now(): this is a fact about
  -- the database, not about the mission.
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mission_state_idx ON mission (state, created_at DESC);
CREATE INDEX mission_name_idx ON mission (name, created_at DESC);

CREATE TABLE mission_task (
  id           text PRIMARY KEY,
  mission_id   text NOT NULL REFERENCES mission (id) ON DELETE CASCADE,
  name         text NOT NULL,
  state        text NOT NULL CHECK (
                 state IN ('pending', 'ready', 'running',
                           'succeeded', 'failed', 'cancelled', 'skipped')
               ),
  handler_kind text NOT NULL CHECK (handler_kind IN ('tool', 'agent')),
  handler_name text NOT NULL,
  -- Task input and result are `unknown` to the kernel — it never inspects a
  -- payload (RFC-0001 §11.4). jsonb keeps them opaque here too, and queryable
  -- if a human ever needs to.
  input        jsonb,
  result       jsonb,
  -- An Error is not JSON-serialisable: JSON.stringify(new Error('x')) is '{}'.
  -- Flattened to {name, message, stack, code} by the repository rather than
  -- stored raw, because a persisted failure with an empty payload is worse than
  -- no persistence at all.
  error        jsonb,
  depends_on   text[] NOT NULL DEFAULT '{}',
  priority     integer NOT NULL DEFAULT 0,
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL,
  started_at   timestamptz,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- The kernel's own invariant, restated: a task name is unique within its
  -- mission and is how dependsOn refers to it.
  UNIQUE (mission_id, name)
);

CREATE INDEX mission_task_mission_idx ON mission_task (mission_id);
CREATE INDEX mission_task_state_idx ON mission_task (state)
  WHERE state IN ('running', 'ready');

-- The append-only log behind the projections above.
--
-- Kept alongside the snapshots, not instead of them, because they answer
-- different questions. `mission`/`mission_task` answer "what is true now" in one
-- indexed read. This answers "what happened, in order" — including the events
-- that leave no trace in a snapshot, like a retry that later succeeded.
CREATE TABLE mission_event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- No FK to mission. This table must accept an event even when the projection
  -- write that accompanies it fails, and runtime:* events belong to no mission
  -- at all. An audit log that can be blocked by a constraint is not an audit log.
  mission_id text,
  task_id    text,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mission_event_mission_idx ON mission_event (mission_id, id)
  WHERE mission_id IS NOT NULL;
CREATE INDEX mission_event_type_idx ON mission_event (type, id);
