/**
 * A checkpoint store that keeps everything in this process.
 *
 * The default, and it is a real implementation rather than a stub: it is
 * completely correct for a single-process host that does not need to survive a
 * restart, which is every test and most development. What it cannot do is the
 * one thing checkpoints are ultimately for — outlive the process — and it says
 * so here rather than pretending.
 *
 * It is also the reference the port is defined against. If a behaviour is not
 * exercised here, the port probably does not need it.
 */

import { CheckpointCorruptError } from '../errors.js';
import {
  TERMINAL_EXECUTION_STATES,
  type ExecutionCheckpoint,
  type ExecutionId,
} from '../model.js';
import type { CheckpointStore } from './checkpoint-store.js';

export class InMemoryCheckpointStore implements CheckpointStore {
  readonly #checkpoints = new Map<ExecutionId, string>();

  /**
   * Stored as JSON text, not as the object.
   *
   * This looks like pointless work in a Map and is the opposite. A store that
   * kept the live object would let a caller mutate a "saved" checkpoint after
   * saving it, and would happily accept a checkpoint containing a class
   * instance, a function, or an `Error` — none of which survive a real store.
   * Round-tripping through JSON means the in-memory store fails on exactly what
   * Postgres would fail on, in a test, on a laptop, instead of in production at
   * 3am. The serialisability requirement in `model.ts` is enforced here or it is
   * enforced nowhere.
   */
  async save(checkpoint: ExecutionCheckpoint): Promise<void> {
    this.#checkpoints.set(checkpoint.id, serialise(checkpoint));
    return Promise.resolve();
  }

  async load(id: ExecutionId): Promise<ExecutionCheckpoint | undefined> {
    const stored = this.#checkpoints.get(id);
    if (stored === undefined) return Promise.resolve(undefined);
    return Promise.resolve(deserialise(id, stored));
  }

  async delete(id: ExecutionId): Promise<boolean> {
    return Promise.resolve(this.#checkpoints.delete(id));
  }

  async pending(): Promise<readonly ExecutionCheckpoint[]> {
    const all = [...this.#checkpoints.entries()].map(([id, stored]) =>
      deserialise(id, stored),
    );
    return Promise.resolve(
      all
        .filter((checkpoint) => !TERMINAL_EXECUTION_STATES.includes(checkpoint.state))
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  /** How many checkpoints are held, settled or not. For tests and diagnostics. */
  get size(): number {
    return this.#checkpoints.size;
  }
}

function serialise(checkpoint: ExecutionCheckpoint): string {
  try {
    return JSON.stringify(checkpoint);
  } catch (thrown) {
    // A circular structure, or a BigInt. Both are things a capability can
    // legitimately return and neither can be checkpointed, so the execution is
    // told now — at the save that would have silently lost it.
    throw new CheckpointCorruptError(
      checkpoint.id,
      `it cannot be serialised (${(thrown as Error).message}). A step result must be ` +
        `plain JSON data: no circular references, class instances, functions or BigInt`,
    );
  }
}

function deserialise(id: ExecutionId, stored: string): ExecutionCheckpoint {
  try {
    return JSON.parse(stored) as ExecutionCheckpoint;
  } catch (thrown) {
    /* c8 ignore next 5 -- Unreachable through this class: nothing but `serialise`
       writes to the Map, so anything read back parses. It exists because the
       method is the seam a subclass or a future backing store would replace, and
       a corrupt read there must be an error naming the execution rather than a
       raw SyntaxError from inside a JSON parser. */
    throw new CheckpointCorruptError(
      id,
      `it is not valid JSON (${(thrown as Error).message})`,
    );
  }
}
