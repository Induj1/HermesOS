/**
 * Importance scoring: how much a memory is worth, decided when it is written.
 *
 * Importance is the number pruning consults to decide what to forget and
 * retrieval consults to break ties. It is therefore the service's most
 * consequential guess, and the design here is shaped by one admission: **any
 * scorer is wrong.** A heuristic cannot know that a throwaway remark was the
 * important part of a conversation.
 *
 * So the architecture does not try to be right. It tries to be *correctable*:
 *
 *   * `ImportanceScorer` is an interface, and the default is one implementation.
 *     Replacing it with an LLM-backed scorer is one object at a composition root
 *     — and that is the expected end state (RFC-0002 §8).
 *   * An explicit score from the caller always wins. A host that knows better is
 *     never overruled by a heuristic.
 *   * `pinned` bypasses scoring entirely, so "never forget this" needs no score
 *     at all.
 *   * Usage is fed back in. A memory that keeps being retrieved has *proven* its
 *     worth, which beats any guess made at write time — see `retentionScore`.
 *
 * All scores are in [0,1], because pruning and ranking combine them with other
 * [0,1] quantities in a weighted sum. A scorer returning 7 would not error; it
 * would quietly dominate every weight in the system.
 */

import type { MemoryKind, MemoryRecord } from './model.js';

export interface ImportanceSignals {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ImportanceScorer {
  /** Returns a score in [0,1]. Must be pure: pruning re-derives, and must agree. */
  score(signals: ImportanceSignals): number;
}

/**
 * Prior importance by kind, before any signal from the content itself.
 *
 * The ordering is the claim, not the exact numbers — nothing downstream should
 * depend on `fact` being 0.70 rather than 0.68, and the weights below are chosen
 * to be too small to overturn the ordering by accident.
 *
 * preference  0.80  A standing instruction. Wrong once = wrong forever after,
 *                   and the user has to repeat themselves. The worst failure.
 * fact        0.70  Durable and cheap to hold. Rarely regretted.
 * task        0.65  An undischarged intention. High value, but self-limiting —
 *                   it expires when done, so it need not be defended by score.
 * summary     0.50  Derived. Regenerable from its sources if they survive, which
 *                   is exactly why it does not deserve a fact's protection.
 * episode     0.35  Most numerous, most redundant, least individually useful.
 *                   Where the pruner is meant to look first.
 */
const KIND_PRIOR: Readonly<Record<MemoryKind, number>> = {
  preference: 0.8,
  fact: 0.7,
  task: 0.65,
  summary: 0.5,
  episode: 0.35,
};

export interface HeuristicImportanceOptions {
  /** Override the per-kind priors. Merged over the defaults. */
  readonly kindPriors?: Readonly<Partial<Record<MemoryKind, number>>>;
  /**
   * Metadata key holding a caller-supplied score in [0,1]. When present and
   * valid, it is returned as-is: a host that knows better is never overruled.
   */
  readonly explicitKey?: string;
}

/**
 * The default scorer: a small pile of cheap lexical signals over a per-kind prior.
 *
 * Every signal below is deliberately weak (≤0.1) and additive. That is the whole
 * design: no single heuristic can move a memory more than a nudge, so being
 * wrong about one costs a rounding error rather than an eviction. The prior does
 * the work; these adjust at the margin.
 *
 * This is a placeholder for a model, and is meant to look like one.
 */
export class HeuristicImportanceScorer implements ImportanceScorer {
  readonly #priors: Readonly<Record<MemoryKind, number>>;
  readonly #explicitKey: string;

  constructor(options: HeuristicImportanceOptions = {}) {
    this.#priors = { ...KIND_PRIOR, ...options.kindPriors };
    this.#explicitKey = options.explicitKey ?? 'importance';
  }

  score(signals: ImportanceSignals): number {
    const explicit = readExplicit(signals.metadata, this.#explicitKey);
    if (explicit !== undefined) return explicit;

    const content = signals.content.trim();
    let score = this.#priors[signals.kind];

    // A bare "ok" carries nothing worth a retrieval slot, whatever its kind.
    if (content.length < 16) score -= 0.1;

    // Specificity. A memory with a number, a date, or a proper noun in it tends
    // to be a commitment ("the 14th", "£40", "Mara") rather than a vibe, and
    // commitments are what someone actually comes back to ask about.
    if (/\d/.test(content)) score += 0.05;
    if (/\b(19|20)\d{2}\b|\b\d{1,2}:\d{2}\b/.test(content)) score += 0.05;
    if (/(?<=[a-z] )[A-Z][a-z]{2,}/.test(content)) score += 0.05;

    // Stated permanence. Someone saying "always" or "never" is telling you the
    // shelf life directly — the strongest signal available without a model, and
    // still only worth 0.1.
    if (/\b(always|never|every|prefer|remember|important)\b/i.test(content)) {
      score += 0.1;
    }
    // ...and the converse. "For now" is an explicit expiry date in prose.
    if (/\b(maybe|might|for now|temporar|guess|probably)\w*\b/i.test(content)) {
      score -= 0.05;
    }

    return clamp01(score);
  }
}

/** A scorer that returns the same number for everything. For tests and for opting out. */
export class ConstantImportanceScorer implements ImportanceScorer {
  readonly #value: number;

  constructor(value = 0.5) {
    this.#value = clamp01(value);
  }

  score(): number {
    return this.#value;
  }
}

export interface RetentionOptions {
  /**
   * Age at which recency's contribution halves, in ms. Default 30 days.
   *
   * The single knob that decides whether this system behaves like a diary or a
   * cache. Shorter forgets faster.
   */
  readonly halfLifeMs?: number;
  /** Weight on the memory's own importance. */
  readonly importanceWeight?: number;
  /** Weight on how recently it was created or read. */
  readonly recencyWeight?: number;
  /** Weight on how often it has been retrieved. */
  readonly usageWeight?: number;
}

const DEFAULT_RETENTION: Required<RetentionOptions> = {
  halfLifeMs: 30 * 24 * 60 * 60 * 1000,
  // Importance leads: what a memory *is* matters more than when it was touched.
  // Recency is the tiebreaker between memories of equal standing, and usage is a
  // small, hard-won correction on top — deliberately the smallest weight, so
  // that a memory retrieved often but genuinely trivial cannot climb forever.
  importanceWeight: 0.5,
  recencyWeight: 0.3,
  usageWeight: 0.2,
};

/**
 * How much this memory deserves to survive the next pruning pass, in [0,1].
 *
 * Recency uses `lastAccessedAt ?? createdAt`, so *reading* a memory keeps it
 * alive. That is the mechanism that lets the system recover from a bad
 * importance guess without anyone intervening: the scorer's mistakes are
 * corrected by use.
 */
export function retentionScore(
  memory: Pick<
    MemoryRecord,
    'importance' | 'createdAt' | 'lastAccessedAt' | 'accessCount'
  >,
  now: number,
  options: RetentionOptions = {},
): number {
  const { halfLifeMs, importanceWeight, recencyWeight, usageWeight } = {
    ...DEFAULT_RETENTION,
    ...options,
  };

  const touchedAt = memory.lastAccessedAt ?? memory.createdAt;
  const recency = decay(now - touchedAt, halfLifeMs);

  // Saturating rather than linear: the difference between 0 and 5 retrievals is
  // real evidence; the difference between 95 and 100 is not. Linear usage would
  // let one hot memory outrank everything else permanently.
  const usage = memory.accessCount / (memory.accessCount + 5);

  const total = importanceWeight + recencyWeight + usageWeight;
  if (total <= 0) return 0;

  return clamp01(
    (memory.importance * importanceWeight +
      recency * recencyWeight +
      usage * usageWeight) /
      total,
  );
}

/**
 * Exponential decay: 1 at age 0, 0.5 at one half-life, asymptotic to 0.
 *
 * Exponential rather than linear because linear decay hits exactly zero at some
 * age and stays there, which makes every memory older than the window
 * indistinguishable — a 40-day-old memory and a 10-year-old one would rank
 * identically. Exponential always leaves an ordering.
 *
 * Negative ages (a clock skew, or a `TestClock` reading behind a record's
 * timestamp) clamp to 1 rather than returning >1, which would let a weight
 * exceed its budget and push the composite score out of [0,1].
 */
export function decay(ageMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 0;
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

export function clamp01(value: number): number {
  // NaN fails every comparison, so it would otherwise flow through untouched and
  // poison the sums that consume this. Checked first, deliberately.
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function readExplicit(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const raw = metadata?.[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return clamp01(raw);
}
