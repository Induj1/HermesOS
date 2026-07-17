/**
 * The checkpoint port: what survives the process.
 *
 * An execution that cannot be resumed after a crash is not resumable, however
 * many `paused` states it has. So the engine writes a checkpoint after every
 * step settles, and this is the interface it writes through.
 *
 * The port is deliberately tiny — four methods over an opaque, serialisable
 * value. It could be Postgres, Redis, a file, or a Map, and the engine must not
 * be able to tell. In particular it does **not** expose a transaction, a query,
 * or a connection: an engine that could open a transaction would eventually run
 * business logic inside one, and the store would stop being replaceable.
 *
 * ## Why the engine does not use `@hermes/memory` for this directly
 *
 * It would fit — memory owns persistence, and this is persistence. It is
 * rejected because a checkpoint is *operational state*, not a memory. Memory's
 * records are scored by importance, pruned when they stop mattering, and
 * retrieved by semantic similarity (RFC-0002 §8). Every one of those is wrong
 * for a checkpoint: it is worthless the moment its execution settles and
 * priceless until then, and no pruner can be taught that distinction without
 * learning what an execution is — which would make memory depend on this
 * package, inverting the dependency graph.
 *
 * So the port stays here, and a Postgres implementation of it lives here too
 * (`PgCheckpointStore`), reusing memory's *public* `Database` and `migrate` — the
 * connection pool and the migrator, which are genuinely general — while owning
 * its own table and its own migrations. That is reuse without coupling.
 */

import type { ExecutionCheckpoint, ExecutionId } from '../model.js';

export interface CheckpointStore {
  /**
   * Write a checkpoint, replacing any earlier one for the same execution.
   *
   * Last-write-wins, because a checkpoint is always *complete* rather than a
   * delta — the same property that lets memory project mission snapshots without
   * ordering guarantees (RFC-0002 §4.3). Two writers racing on one execution is
   * a bug in the caller, not a case for the store to arbitrate.
   */
  save(checkpoint: ExecutionCheckpoint): Promise<void>;

  /** The stored checkpoint, or `undefined` if there is none. */
  load(id: ExecutionId): Promise<ExecutionCheckpoint | undefined>;

  /**
   * Forget an execution.
   *
   * Returns whether anything was there — so a caller can tell "deleted" from
   * "already gone" without a read first, and neither is an error.
   */
  delete(id: ExecutionId): Promise<boolean>;

  /**
   * Executions that have not settled, oldest first.
   *
   * The port's whole reason for existing beyond `load`: after a crash, nothing
   * knows which executions were in flight. This is what a supervisor asks on
   * boot to find the work that needs picking up. Settled executions are excluded
   * because they are not work — they are history, and history belongs in
   * `@hermes/memory`.
   */
  pending(): Promise<readonly ExecutionCheckpoint[]>;
}
