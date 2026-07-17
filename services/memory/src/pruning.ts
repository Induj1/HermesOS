/**
 * Pruning: deciding what to forget.
 *
 * The most dangerous code in this service, and the design reflects that at every
 * level:
 *
 *   * **It is a soft delete.** `forget` sets `forgotten_at`; it does not DELETE.
 *     A pruning bug is then recoverable by clearing a column, not by restoring a
 *     backup. Hard deletion is a separate, explicit, never-automatic call
 *     (`MemoryRepository.purgeForgotten`).
 *   * **It plans before it acts.** `plan()` is pure and returns what *would* be
 *     forgotten, with a reason per memory. `apply()` executes a plan. That split
 *     is what makes the policy unit-testable with no database, and what lets a
 *     host log or approve a plan before running it.
 *   * **Pinned memories are untouchable.** No score, no age, no quota can evict
 *     one. It is the escape hatch that does not require trusting the scorer.
 *   * **It is an interface.** The default is a policy, not a law.
 *
 * The policy runs in three passes, cheapest and most certain first:
 *
 *   1. **Expired** — `expires_at` has passed. The caller told us the shelf life;
 *      no judgement required.
 *   2. **Decayed** — `retentionScore` below a floor. The scorer's opinion, aged.
 *   3. **Over quota** — more than `maxPerSubject` survive; drop the weakest.
 *      Unlike the first two, this forgets memories that are *fine*, purely
 *      because there are too many. It runs last for that reason.
 */

import type { Clock, Logger } from '@hermes/kernel';
import { noopLogger } from '@hermes/kernel';
import { retentionScore, type RetentionOptions } from './importance.js';
import type { MemoryId, MemoryRecord, Subject } from './model.js';
import type { MemoryRepository } from './repositories/memory-repository.js';

export type PruneReason = 'expired' | 'decayed' | 'over-quota';

export interface PrunedMemory {
  readonly id: MemoryId;
  readonly reason: PruneReason;
  /** The retention score at the moment of the decision. For explaining the plan. */
  readonly score: number;
  readonly content: string;
}

export interface PrunePlan {
  readonly subject: Subject;
  readonly forget: readonly PrunedMemory[];
  readonly kept: number;
  readonly evaluated: number;
}

export interface PruningStrategy {
  /** Pure. Decides what to forget, without touching anything. */
  plan(memories: readonly MemoryRecord[], subject: Subject, now: number): PrunePlan;
}

export interface RetentionPruningOptions extends RetentionOptions {
  /**
   * Forget memories whose retention score falls below this. Default 0.15.
   *
   * Low on purpose. With the default 30-day half-life, a mid-importance memory
   * has to go unread for roughly three months to fall this far. Pruning should
   * feel like forgetting, not like a cache eviction — the cost of keeping a
   * useless memory is a few bytes, and the cost of dropping a needed one is the
   * user having to repeat themselves.
   */
  readonly minRetention?: number;
  /**
   * Hard ceiling on live memories per subject. Default 10,000.
   *
   * The backstop that keeps `BruteForceIndex` viable — it reads every vector for
   * a subject — and keeps unbounded growth from becoming a retrieval-latency
   * problem nobody traced back to here.
   */
  readonly maxPerSubject?: number;
  /**
   * Never forget anything newer than this, whatever it scores. Default 24h.
   *
   * A memory written minutes ago has no usage history and its importance is a
   * guess. Judging it immediately means judging it on the least information the
   * system will ever have about it — and a fresh, low-scored memory is exactly
   * the "actually the user just told us this" case. Give it a day to prove itself.
   */
  readonly graceMs?: number;
}

/**
 * The default strategy. See the file header for the three passes.
 */
export class RetentionPruningStrategy implements PruningStrategy {
  readonly #minRetention: number;
  readonly #maxPerSubject: number;
  readonly #graceMs: number;
  readonly #retention: RetentionOptions;

  constructor(options: RetentionPruningOptions = {}) {
    const { minRetention, maxPerSubject, graceMs, ...retention } = options;
    this.#minRetention = minRetention ?? 0.15;
    this.#maxPerSubject = maxPerSubject ?? 10_000;
    this.#graceMs = graceMs ?? 24 * 60 * 60 * 1000;
    this.#retention = retention;
  }

  plan(memories: readonly MemoryRecord[], subject: Subject, now: number): PrunePlan {
    const live = memories.filter((memory) => memory.forgottenAt === undefined);
    const forget: PrunedMemory[] = [];
    const doomed = new Set<MemoryId>();

    const condemn = (
      memory: MemoryRecord,
      reason: PruneReason,
      score: number,
    ): void => {
      if (doomed.has(memory.id)) return;
      doomed.add(memory.id);
      forget.push({ id: memory.id, reason, score, content: memory.content });
    };

    // Pass 1 — expired. Applies to pinned memories too: an explicit expiry is
    // the caller being specific, and it outranks the blanket "keep this" that
    // pinning expresses. Anything else would make `pinned` a way to accidentally
    // immortalise a memory that was declared temporary at birth.
    for (const memory of live) {
      if (memory.expiresAt !== undefined && memory.expiresAt <= now) {
        condemn(memory, 'expired', 0);
      }
    }

    // Candidates for the score-based passes: unpinned, unexpired, out of grace.
    const scored = live
      .filter(
        (memory) =>
          !doomed.has(memory.id) &&
          !memory.pinned &&
          now - memory.createdAt >= this.#graceMs,
      )
      .map((memory) => ({
        memory,
        score: retentionScore(memory, now, this.#retention),
      }))
      .sort((a, b) => a.score - b.score || a.memory.createdAt - b.memory.createdAt);

    // Pass 2 — decayed.
    for (const { memory, score } of scored) {
      if (score < this.#minRetention) condemn(memory, 'decayed', score);
    }

    // Pass 3 — over quota. Counts every survivor, including pinned and in-grace
    // memories that passes 1 and 2 could not touch, because the quota is about
    // how many rows exist — but only evicts from `scored`, which excludes them.
    // A subject over quota entirely in pinned memories therefore stays over
    // quota, which is correct: the alternative is a quota that overrides an
    // explicit "never forget this".
    const survivors = live.filter((memory) => !doomed.has(memory.id));
    let excess = survivors.length - this.#maxPerSubject;
    if (excess > 0) {
      // `scored` is ascending by retention, so this evicts the weakest first and
      // stops the moment the subject is back under quota. The `doomed` check is
      // what makes the counter honest: a memory already condemned as decayed is
      // skipped by `condemn`, and counting it here would end the loop early and
      // leave the subject over quota.
      for (const { memory, score } of scored) {
        if (excess <= 0) break;
        if (doomed.has(memory.id)) continue;
        condemn(memory, 'over-quota', score);
        excess--;
      }
    }

    return {
      subject,
      forget,
      kept: live.length - forget.length,
      evaluated: live.length,
    };
  }
}

/** A strategy that forgets nothing. For hosts that want to prune by hand, and for tests. */
export class NeverPruneStrategy implements PruningStrategy {
  // `_now` is unused but declared: dropping it would narrow this class's own
  // signature to two parameters, so calling it directly with three — as a test
  // reasonably does — would not compile, even though it satisfies the interface.
  plan(memories: readonly MemoryRecord[], subject: Subject, _now?: number): PrunePlan {
    const live = memories.filter((memory) => memory.forgottenAt === undefined);
    return { subject, forget: [], kept: live.length, evaluated: live.length };
  }
}

export interface PrunerOptions {
  readonly strategy?: PruningStrategy;
  readonly logger?: Logger;
  /**
   * Plan and log, but do not write. Default false.
   *
   * The right way to introduce pruning to a database that matters: run it dry
   * for a week and read the logs before letting it touch anything.
   */
  readonly dryRun?: boolean;
  /** Memories to evaluate per subject per pass. Default 20,000. */
  readonly batchSize?: number;
}

/** Runs a {@link PruningStrategy} against the database. */
export class Pruner {
  readonly #memories: MemoryRepository;
  readonly #clock: Clock;
  readonly #strategy: PruningStrategy;
  readonly #logger: Logger;
  readonly #dryRun: boolean;
  readonly #batchSize: number;

  constructor(memories: MemoryRepository, clock: Clock, options: PrunerOptions = {}) {
    this.#memories = memories;
    this.#clock = clock;
    this.#strategy = options.strategy ?? new RetentionPruningStrategy();
    this.#logger = options.logger ?? noopLogger;
    this.#dryRun = options.dryRun ?? false;
    this.#batchSize = options.batchSize ?? 20_000;
  }

  /** Plan without writing. Safe to call anywhere, including from a read path. */
  async plan(subject: Subject): Promise<PrunePlan> {
    const memories = await this.#memories.list(subject, {
      limit: this.#batchSize,
      includeForgotten: false,
      includeExpired: true,
    });
    return this.#strategy.plan(memories, subject, this.#clock.now());
  }

  /** Plan, then soft-delete what the plan condemns. Returns the plan that was run. */
  async prune(subject: Subject): Promise<PrunePlan> {
    const plan = await this.plan(subject);
    if (plan.forget.length === 0) return plan;

    if (this.#dryRun) {
      this.#logger.info('Pruning (dry run): would forget memories', {
        subject,
        count: plan.forget.length,
        reasons: summariseReasons(plan.forget),
      });
      return plan;
    }

    const forgotten = await this.#memories.forget(plan.forget.map((entry) => entry.id));
    this.#logger.info('Pruned memories', {
      subject,
      forgotten,
      kept: plan.kept,
      reasons: summariseReasons(plan.forget),
    });
    return plan;
  }
}

function countBy(entries: readonly PrunedMemory[], reason: PruneReason): number {
  return entries.filter((entry) => entry.reason === reason).length;
}

function summariseReasons(
  entries: readonly PrunedMemory[],
): Readonly<Record<PruneReason, number>> {
  return {
    expired: countBy(entries, 'expired'),
    decayed: countBy(entries, 'decayed'),
    'over-quota': countBy(entries, 'over-quota'),
  };
}
