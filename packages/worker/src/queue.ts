/**
 * The job queue — a port, and a deterministic in-memory implementation.
 *
 * The worker drains work through this interface, so the *store* is swappable: the
 * in-memory queue here is the default and the test double; a Postgres- or
 * Redis-backed queue implements the same three verbs (claim, ack, retry) and the
 * worker never changes. The port is small on purpose — a queue's whole contract is
 * "hand me the next available jobs, let me confirm or defer each" — and everything
 * time-related (a retry's delay, availability) is expressed as an absolute
 * `availableAtMs` so the store needs no clock of its own and a caller drives time.
 */

export interface QueuedJob<J> {
  readonly id: string;
  readonly body: J;
  /** How many times this job has been attempted (0 before the first claim). */
  readonly attempts: number;
}

export interface EnqueueOptions {
  /** A caller-chosen id (for idempotency). Generated when absent. */
  readonly id?: string;
  /** The earliest time the job may be claimed. Default: immediately. */
  readonly availableAtMs?: number;
}

export interface QueueStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly dead: number;
}

export interface JobQueue<J> {
  /** Add a job; returns its id. */
  enqueue(body: J, options?: EnqueueOptions): Promise<string>;
  /** Claim up to `max` jobs available at `nowMs`, marking them in-flight. */
  claim(max: number, nowMs: number): Promise<readonly QueuedJob<J>[]>;
  /** Confirm a claimed job succeeded; it is removed. */
  ack(id: string): Promise<void>;
  /** Return a claimed job to the queue, available at `availableAtMs`, with one more attempt counted. */
  retry(id: string, availableAtMs: number): Promise<void>;
  /** Move a claimed job to the dead-letter queue with a reason. */
  deadLetter(id: string, reason: string): Promise<void>;
  stats(): QueueStats;
}

interface Entry<J> {
  readonly id: string;
  readonly body: J;
  attempts: number;
  availableAtMs: number;
}

export interface DeadJob<J> {
  readonly id: string;
  readonly body: J;
  readonly attempts: number;
  readonly reason: string;
}

/**
 * A deterministic in-memory queue.
 *
 * Ids are a monotonic counter (`job-1`, `job-2`, …) rather than random, so a test
 * can predict them and a replay is reproducible. `claim` returns jobs in
 * availability order (earliest `availableAtMs` first, ties by enqueue order), so
 * the drain order is defined, not a `Map` iteration accident.
 */
export class InMemoryJobQueue<J> implements JobQueue<J> {
  readonly #pending: Entry<J>[] = [];
  readonly #inFlight = new Map<string, Entry<J>>();
  readonly #dead: DeadJob<J>[] = [];
  #seq = 0;

  enqueue(body: J, options: EnqueueOptions = {}): Promise<string> {
    const id = options.id ?? `job-${String((this.#seq += 1))}`;
    this.#pending.push({
      id,
      body,
      attempts: 0,
      availableAtMs: options.availableAtMs ?? 0,
    });
    return Promise.resolve(id);
  }

  claim(max: number, nowMs: number): Promise<readonly QueuedJob<J>[]> {
    const available = this.#pending
      .filter((e) => e.availableAtMs <= nowMs)
      .sort((a, b) => a.availableAtMs - b.availableAtMs);
    const claimed = available.slice(0, Math.max(0, max));
    for (const entry of claimed) {
      remove(this.#pending, entry);
      entry.attempts += 1;
      this.#inFlight.set(entry.id, entry);
    }
    return Promise.resolve(
      claimed.map((e) => ({ id: e.id, body: e.body, attempts: e.attempts })),
    );
  }

  ack(id: string): Promise<void> {
    this.#inFlight.delete(id);
    return Promise.resolve();
  }

  retry(id: string, availableAtMs: number): Promise<void> {
    const entry = this.#inFlight.get(id);
    if (entry !== undefined) {
      this.#inFlight.delete(id);
      entry.availableAtMs = availableAtMs;
      this.#pending.push(entry);
    }
    return Promise.resolve();
  }

  deadLetter(id: string, reason: string): Promise<void> {
    const entry = this.#inFlight.get(id);
    if (entry !== undefined) {
      this.#inFlight.delete(id);
      this.#dead.push({
        id: entry.id,
        body: entry.body,
        attempts: entry.attempts,
        reason,
      });
    }
    return Promise.resolve();
  }

  stats(): QueueStats {
    return {
      pending: this.#pending.length,
      inFlight: this.#inFlight.size,
      dead: this.#dead.length,
    };
  }

  /** The dead-letter queue, for inspection. */
  deadJobs(): readonly DeadJob<J>[] {
    return [...this.#dead];
  }
}

function remove<T>(array: T[], item: T): void {
  const index = array.indexOf(item);
  if (index !== -1) array.splice(index, 1);
}
