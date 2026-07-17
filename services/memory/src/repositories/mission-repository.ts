/**
 * Mission persistence.
 *
 * The kernel is in-memory and single-process, and a restart loses every in-flight
 * mission. RFC-0001 §11.2 names the seam and this file uses exactly that seam and
 * no other: **every kernel event carries a plain, serialisable snapshot**, so a
 * store is something that subscribes and writes. Nothing here reaches into the
 * kernel, and the kernel never reads these tables.
 *
 * Two things this file is careful about:
 *
 *   * **Errors are not JSON.** `JSON.stringify(new Error('boom'))` is `'{}'` —
 *     `message` and `stack` are non-enumerable. A `task:failed` event persisted
 *     naively records that a task failed and nothing about why. `flattenError`
 *     is the fix, and it is the single most valuable line in this file.
 *   * **Snapshots are epoch millis.** The kernel's clock is injectable, and a
 *     `TestClock` starts at 0. Timestamps come from the snapshot, never from
 *     `now()`, or persisted history disagrees with the kernel that produced it.
 *
 * What this does NOT do is rehydrate. See `RFC-0002 §9`.
 */

import type { MissionId, MissionSnapshot, TaskId, TaskSnapshot } from '@hermes/kernel';
import type { Queryable, QueryRow } from '../db/database.js';
import { toEpoch, toNumber } from './mappers.js';

export interface PersistedMission {
  readonly mission: MissionSnapshot;
  /** Wall-clock time of the write. A fact about the database, not the mission. */
  readonly recordedAt: number;
}

export interface MissionEventRecord {
  readonly id: number;
  readonly missionId: MissionId | undefined;
  readonly taskId: TaskId | undefined;
  readonly type: string;
  readonly payload: unknown;
  readonly at: number;
}

interface MissionRow extends QueryRow {
  id: string;
  name: string;
  goal: string | null;
  state: string;
  failure_policy: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  finished_at: Date | null;
  recorded_at: Date;
}

interface MissionTaskRow extends QueryRow {
  id: string;
  mission_id: string;
  name: string;
  state: string;
  handler_kind: string;
  handler_name: string;
  input: unknown;
  result: unknown;
  error: FlatError | null;
  depends_on: string[];
  priority: number;
  attempts: number;
  max_attempts: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** An Error, reduced to something jsonb can hold and a human can read. */
export interface FlatError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** The kernel's `KernelError.code`, when the error carried one. */
  readonly code?: string;
  readonly cause?: FlatError;
}

export class MissionRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  withQueryable(db: Queryable): MissionRepository {
    return new MissionRepository(db);
  }

  /**
   * Write a mission snapshot and all of its tasks.
   *
   * Upsert, not insert: the same mission is saved repeatedly as it progresses,
   * once per event. The projection is last-write-wins because the snapshot is
   * always complete — it is not a delta, so there is nothing to merge.
   *
   * Not internally transactional. Callers that need the mission row and its
   * tasks to land together pass a transaction handle in (`withQueryable(tx)`),
   * which is exactly what `saveWithEvent` does.
   */
  async save(snapshot: MissionSnapshot): Promise<void> {
    await this.#db.query(
      `INSERT INTO mission (id, name, goal, state, failure_policy, metadata, created_at, finished_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp($7), to_timestamp($8), now())
       ON CONFLICT (id) DO UPDATE
         SET state = EXCLUDED.state,
             goal = EXCLUDED.goal,
             metadata = EXCLUDED.metadata,
             finished_at = EXCLUDED.finished_at,
             updated_at = now()`,
      [
        snapshot.id,
        snapshot.name,
        snapshot.goal ?? null,
        snapshot.state,
        snapshot.failurePolicy,
        JSON.stringify(snapshot.metadata),
        snapshot.createdAt / 1000,
        secondsOrNull(snapshot.finishedAt),
      ],
    );

    for (const task of snapshot.tasks) {
      await this.#saveTask(snapshot.id, task);
    }
  }

  async #saveTask(missionId: MissionId, task: TaskSnapshot): Promise<void> {
    await this.#db.query(
      `INSERT INTO mission_task (
         id, mission_id, name, state, handler_kind, handler_name,
         input, result, error, depends_on, priority, attempts, max_attempts,
         metadata, created_at, started_at, finished_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::text[],
               $11, $12, $13, $14::jsonb,
               to_timestamp($15), to_timestamp($16), to_timestamp($17), now())
       ON CONFLICT (id) DO UPDATE
         SET state = EXCLUDED.state,
             result = EXCLUDED.result,
             error = EXCLUDED.error,
             attempts = EXCLUDED.attempts,
             started_at = EXCLUDED.started_at,
             finished_at = EXCLUDED.finished_at,
             metadata = EXCLUDED.metadata,
             updated_at = now()`,
      [
        task.id,
        missionId,
        task.name,
        task.state,
        task.handler.kind,
        task.handler.name,
        toJsonb(task.input),
        toJsonb(task.result),
        task.error ? JSON.stringify(flattenError(task.error)) : null,
        task.dependsOn,
        task.priority,
        task.attempts,
        task.maxAttempts,
        JSON.stringify(task.metadata),
        task.createdAt / 1000,
        // to_timestamp(NULL) is NULL, so an unstarted task needs no special case.
        secondsOrNull(task.startedAt),
        secondsOrNull(task.finishedAt),
      ],
    );
  }

  /** Append to the audit log. Never fails on a missing mission — there is no FK. */
  async appendEvent(
    type: string,
    payload: unknown,
    context: { missionId?: MissionId; taskId?: TaskId } = {},
  ): Promise<void> {
    await this.#db.query(
      `INSERT INTO mission_event (mission_id, task_id, type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        context.missionId ?? null,
        context.taskId ?? null,
        type,
        toJsonb(payload) ?? 'null',
      ],
    );
  }

  async findById(id: MissionId): Promise<MissionSnapshot | undefined> {
    const { rows } = await this.#db.query<MissionRow>(
      'SELECT * FROM mission WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;

    const { rows: taskRows } = await this.#db.query<MissionTaskRow>(
      'SELECT * FROM mission_task WHERE mission_id = $1 ORDER BY created_at, name',
      [id],
    );
    return mapMission(row, taskRows);
  }

  async listByState(
    state: MissionSnapshot['state'],
    limit = 50,
  ): Promise<readonly MissionSnapshot[]> {
    const { rows } = await this.#db.query<MissionRow>(
      'SELECT * FROM mission WHERE state = $1 ORDER BY created_at DESC LIMIT $2',
      [state, limit],
    );
    // Tasks in one query rather than one per mission: `listByState('running')` on
    // startup is exactly the query someone runs to find what a crash interrupted,
    // and N+1 is a bad look on the recovery path.
    return this.#attachTasks(rows);
  }

  async listRecent(limit = 50): Promise<readonly MissionSnapshot[]> {
    const { rows } = await this.#db.query<MissionRow>(
      'SELECT * FROM mission ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return this.#attachTasks(rows);
  }

  async #attachTasks(rows: readonly MissionRow[]): Promise<readonly MissionSnapshot[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const { rows: taskRows } = await this.#db.query<MissionTaskRow>(
      'SELECT * FROM mission_task WHERE mission_id = ANY($1::text[]) ORDER BY created_at, name',
      [ids],
    );
    const byMission = new Map<string, MissionTaskRow[]>();
    for (const task of taskRows) {
      const list = byMission.get(task.mission_id) ?? [];
      list.push(task);
      byMission.set(task.mission_id, list);
    }
    return rows.map((row) => mapMission(row, byMission.get(row.id) ?? []));
  }

  async events(
    missionId: MissionId,
    limit = 200,
  ): Promise<readonly MissionEventRecord[]> {
    const { rows } = await this.#db.query<{
      id: string;
      mission_id: string | null;
      task_id: string | null;
      type: string;
      payload: unknown;
      at: Date;
    }>('SELECT * FROM mission_event WHERE mission_id = $1 ORDER BY id ASC LIMIT $2', [
      missionId,
      limit,
    ]);
    return rows.map((row) => ({
      id: toNumber(row.id),
      missionId: (row.mission_id ?? undefined) as MissionId | undefined,
      taskId: (row.task_id ?? undefined) as TaskId | undefined,
      type: row.type,
      payload: row.payload,
      at: row.at.getTime(),
    }));
  }

  /** Drop missions finished before the cutoff. Their tasks and events go too. */
  async purgeFinishedBefore(epochMs: number): Promise<number> {
    const { rowCount } = await this.#db.query(
      `WITH doomed AS (
         DELETE FROM mission
          WHERE finished_at IS NOT NULL AND finished_at < to_timestamp($1)
         RETURNING id
       )
       DELETE FROM mission_event
        WHERE mission_id IN (SELECT id FROM doomed)`,
      [epochMs / 1000],
    );
    // mission_task cascades from mission; mission_event has no FK (by design —
    // see migration 0003), so it is swept explicitly here.
    return rowCount;
  }
}

function mapMission(
  row: MissionRow,
  taskRows: readonly MissionTaskRow[],
): MissionSnapshot {
  return {
    id: row.id as MissionId,
    name: row.name,
    goal: row.goal ?? undefined,
    state: row.state as MissionSnapshot['state'],
    failurePolicy: row.failure_policy as MissionSnapshot['failurePolicy'],
    metadata: row.metadata,
    createdAt: row.created_at.getTime(),
    finishedAt: toEpoch(row.finished_at),
    tasks: taskRows.map(mapTask),
  };
}

function mapTask(row: MissionTaskRow): TaskSnapshot {
  return {
    id: row.id as TaskId,
    missionId: row.mission_id as MissionId,
    name: row.name,
    state: row.state as TaskSnapshot['state'],
    handler: {
      kind: row.handler_kind as 'tool',
      name: row.handler_name,
    },
    input: row.input,
    dependsOn: row.depends_on,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    metadata: row.metadata,
    createdAt: row.created_at.getTime(),
    startedAt: toEpoch(row.started_at),
    finishedAt: toEpoch(row.finished_at),
    result: row.result,
    // Rebuilt as a real Error, not left as the flat object: `TaskSnapshot.error`
    // is typed `Error | undefined`, and a consumer doing `err instanceof Error`
    // or reading `.stack` must not have to know this one came out of a database.
    error: row.error ? inflateError(row.error) : undefined,
  };
}

/**
 * Reduce an Error to something jsonb can hold.
 *
 * `JSON.stringify(new Error('boom'))` returns `'{}'`: `name`, `message`, and
 * `stack` are non-enumerable own properties, so the default serialisation of a
 * failure is nothing at all. Every field is therefore copied by hand.
 *
 * `cause` is followed to a bounded depth. Kernel errors chain — a `PluginError`
 * wraps whatever the plugin threw — and that inner error is usually the one
 * worth reading. The depth cap exists because a cause chain can be cyclic
 * (`a.cause = b; b.cause = a`), which would otherwise recurse until the stack
 * gives out.
 */
export function flattenError(error: Error, depth = 0): FlatError {
  const flat: FlatError = {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    // KernelError and MemoryError both carry a stable `code` that callers branch
    // on (RFC-0001 §5). It is the field that survives a message rewording, so it
    // is the field most worth persisting.
    ...(hasCode(error) ? { code: error.code } : {}),
  };

  if (depth >= 4 || !(error.cause instanceof Error)) return flat;
  return { ...flat, cause: flattenError(error.cause, depth + 1) };
}

function inflateError(flat: FlatError): Error {
  const error = new Error(
    flat.message,
    flat.cause ? { cause: inflateError(flat.cause) } : {},
  );
  error.name = flat.name;
  // The original stack, not this frame's. A stack pointing at a mapper function
  // is worse than no stack: it is confidently wrong about where the error came
  // from.
  if (flat.stack !== undefined) error.stack = flat.stack;
  if (flat.code !== undefined) {
    Object.defineProperty(error, 'code', { value: flat.code, enumerable: false });
  }
  return error;
}

function hasCode(error: Error): error is Error & { code: string } {
  return 'code' in error && typeof (error as { code: unknown }).code === 'string';
}

/**
 * Serialise a task payload for a jsonb column.
 *
 * `undefined` becomes SQL NULL rather than the string "undefined" — the kernel
 * uses undefined for "no input" and JSON.stringify(undefined) returns undefined,
 * which `pg` would send as NULL anyway; being explicit documents that it is
 * intended rather than incidental.
 *
 * A payload that cannot be serialised (a cycle, a BigInt) is recorded as an
 * error object instead of throwing. The kernel treats payloads as opaque
 * (RFC-0001 §11.4) and cannot promise they are JSON — and losing the audit trail
 * for a whole mission because one task's input held a circular reference is a
 * far worse outcome than storing a note about it.
 */
function toJsonb(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    // The `??` is not dead code, whatever the lint rule infers from the lib
    // types — the same trap the kernel documents in errors.ts. JSON.stringify is
    // declared as returning string, but genuinely returns undefined for a
    // function or a symbol, either of which can be a task's opaque input. The
    // catch covers the other half: cycles and BigInt.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return JSON.stringify(value) ?? null;
  } catch (thrown) {
    return JSON.stringify({
      __unserialisable: true,
      reason: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }
}

function secondsOrNull(epochMs: number | undefined): number | null {
  return epochMs === undefined ? null : epochMs / 1000;
}
