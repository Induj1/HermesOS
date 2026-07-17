/**
 * Importance and retention scoring.
 *
 * Pure functions, so these tests are synchronous and need no database — the same
 * payoff the kernel gets from keeping `Mission.refresh` pure (RFC-0001 §12).
 *
 * They assert *orderings and invariants*, not exact numbers. `HeuristicImportanceScorer`
 * is explicitly a placeholder for a model (RFC-0002 §8), and a test asserting
 * that a fact scores 0.70 would fail the moment someone tuned a weight — while
 * telling you nothing about whether the scorer got better or worse. What must
 * hold across any retuning is that a preference outranks an episode and that
 * every score is in [0,1]. Those are the tests.
 */

import { describe, expect, it } from 'vitest';
import {
  clamp01,
  ConstantImportanceScorer,
  decay,
  HeuristicImportanceScorer,
  retentionScore,
} from '../src/importance.js';
import type { MemoryKind, MemoryRecord } from '../src/model.js';
import { MEMORY_KINDS, toMemoryId } from '../src/model.js';

const DAY = 24 * 60 * 60 * 1000;

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: toMemoryId('00000000-0000-0000-0000-000000000001'),
    subject: 'ada',
    kind: 'fact',
    content: 'Something',
    sourceConversationId: undefined,
    sourceMessageId: undefined,
    metadata: {},
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: undefined,
    pinned: false,
    expiresAt: undefined,
    createdAt: 0,
    updatedAt: 0,
    forgottenAt: undefined,
    ...overrides,
  };
}

describe('clamp01', () => {
  it('passes through values already in range', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps out-of-range values to the boundary', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });

  it('maps NaN to 0 rather than letting it through', () => {
    // NaN fails every comparison, so a naive min/max clamp returns it unchanged
    // and it then poisons every weighted sum downstream — silently, because
    // NaN < threshold is false and it survives every filter.
    expect(clamp01(NaN)).toBe(0);
  });
});

describe('decay', () => {
  it('is 1 at age zero and 0.5 at one half-life', () => {
    expect(decay(0, DAY)).toBe(1);
    expect(decay(DAY, DAY)).toBeCloseTo(0.5, 10);
    expect(decay(2 * DAY, DAY)).toBeCloseTo(0.25, 10);
  });

  it('never reaches zero, so old memories stay ordered', () => {
    // The reason for exponential rather than linear decay: linear hits zero and
    // stays there, making a 40-day-old memory and a 10-year-old one rank
    // identically. There must always be an ordering.
    const old = decay(365 * DAY, 30 * DAY);
    const older = decay(3650 * DAY, 30 * DAY);
    expect(old).toBeGreaterThan(0);
    expect(old).toBeGreaterThan(older);
  });

  it('clamps negative ages to 1 instead of exceeding it', () => {
    // A TestClock reading behind a record's timestamp, or clock skew. Returning
    // >1 would let a weight exceed its budget and push a composite score out of
    // [0,1].
    expect(decay(-DAY, DAY)).toBe(1);
  });

  it('returns 0 for a non-positive half-life rather than dividing by zero', () => {
    expect(decay(DAY, 0)).toBe(0);
    expect(decay(DAY, -1)).toBe(0);
  });
});

describe('HeuristicImportanceScorer', () => {
  const scorer = new HeuristicImportanceScorer();

  it('scores every kind within [0,1]', () => {
    for (const kind of MEMORY_KINDS) {
      const score = scorer.score({
        kind,
        content: 'The meeting is at 14:00 on the 3rd',
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a preference above an episode', () => {
    // The ordering is the scorer's actual claim; the numbers are not. See the
    // file header.
    const content = 'Brief me at seven in the morning';
    expect(scorer.score({ kind: 'preference', content })).toBeGreaterThan(
      scorer.score({ kind: 'episode', content }),
    );
  });

  it('ranks kinds in the documented order for identical content', () => {
    const content = 'Some neutral statement of fact about things';
    const ranked: MemoryKind[] = ['preference', 'fact', 'task', 'summary', 'episode'];
    const scores = ranked.map((kind) => scorer.score({ kind, content }));

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThan(scores[i] ?? 0);
    }
  });

  it('honours an explicit score from metadata over any heuristic', () => {
    // The contract that matters most here: a host that knows better is never
    // overruled by a guess.
    const score = scorer.score({
      kind: 'episode', // the lowest prior
      content: 'x', // and short, which is penalised
      metadata: { importance: 0.99 },
    });
    expect(score).toBe(0.99);
  });

  it('clamps an out-of-range explicit score rather than passing it through', () => {
    expect(
      scorer.score({ kind: 'fact', content: 'x', metadata: { importance: 5 } }),
    ).toBe(1);
    expect(
      scorer.score({ kind: 'fact', content: 'x', metadata: { importance: -5 } }),
    ).toBe(0);
  });

  it('ignores a non-numeric explicit score and falls back to the heuristic', () => {
    const withJunk = scorer.score({
      kind: 'fact',
      content: 'A reasonably long statement about something',
      metadata: { importance: 'very' },
    });
    const without = scorer.score({
      kind: 'fact',
      content: 'A reasonably long statement about something',
    });
    expect(withJunk).toBe(without);
  });

  it('penalises trivially short content', () => {
    expect(scorer.score({ kind: 'fact', content: 'ok' })).toBeLessThan(
      scorer.score({ kind: 'fact', content: 'Their sister is called Mara' }),
    );
  });

  it('rewards stated permanence', () => {
    expect(
      scorer.score({ kind: 'fact', content: 'They always take the train to work' }),
    ).toBeGreaterThan(
      scorer.score({ kind: 'fact', content: 'They took the train to work today' }),
    );
  });

  it('discounts hedged content', () => {
    expect(
      scorer.score({
        kind: 'fact',
        content: 'They might possibly move house, probably',
      }),
    ).toBeLessThan(
      scorer.score({ kind: 'fact', content: 'They are moving house on the 3rd' }),
    );
  });

  it('accepts overridden kind priors', () => {
    const inverted = new HeuristicImportanceScorer({ kindPriors: { episode: 0.95 } });
    const content = 'Some neutral statement of fact about things';
    expect(inverted.score({ kind: 'episode', content })).toBeGreaterThan(
      inverted.score({ kind: 'fact', content }),
    );
  });

  it('is pure: the same signals always give the same score', () => {
    // Pruning re-derives scores and must agree with what was written, so a
    // scorer that drifted between calls would make eviction non-deterministic.
    const signals = { kind: 'fact' as const, content: 'The meeting is at 14:00' };
    const first = scorer.score(signals);
    for (let i = 0; i < 10; i++) expect(scorer.score(signals)).toBe(first);
  });
});

describe('ConstantImportanceScorer', () => {
  it('returns its value regardless of input', () => {
    const scorer = new ConstantImportanceScorer(0.42);
    expect(scorer.score()).toBe(0.42);
  });

  it('clamps its configured value', () => {
    expect(new ConstantImportanceScorer(9).score()).toBe(1);
  });
});

describe('retentionScore', () => {
  const now = 100 * DAY;

  it('stays within [0,1] across extremes', () => {
    const extremes = [
      memory({ importance: 1, createdAt: now, accessCount: 10_000 }),
      memory({ importance: 0, createdAt: 0, accessCount: 0 }),
    ];
    for (const record of extremes) {
      const score = retentionScore(record, now);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a fresh memory above an identical stale one', () => {
    const fresh = retentionScore(memory({ createdAt: now }), now);
    const stale = retentionScore(memory({ createdAt: now - 365 * DAY }), now);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('ranks an important memory above an identical unimportant one', () => {
    const high = retentionScore(memory({ importance: 0.9, createdAt: now }), now);
    const low = retentionScore(memory({ importance: 0.1, createdAt: now }), now);
    expect(high).toBeGreaterThan(low);
  });

  it('counts a read as recency, so retrieval keeps a memory alive', () => {
    // The feedback loop that lets use correct a bad importance guess without
    // anyone intervening. This is the single most important assertion in the file.
    const old = memory({ createdAt: now - 300 * DAY });
    const read = memory({ createdAt: now - 300 * DAY, lastAccessedAt: now - DAY });
    expect(retentionScore(read, now)).toBeGreaterThan(retentionScore(old, now));
  });

  it('rewards usage with diminishing returns', () => {
    const at = (accessCount: number): number =>
      retentionScore(memory({ accessCount, createdAt: now }), now);

    // Saturating, not linear: the first few retrievals are real evidence, the
    // ninety-fifth is not. Linear usage would let one hot memory outrank
    // everything else permanently.
    const firstFive = at(5) - at(0);
    const nextNinetyFive = at(100) - at(5);
    expect(firstFive).toBeGreaterThan(0);
    expect(nextNinetyFive).toBeGreaterThan(0);
    expect(firstFive).toBeGreaterThan(nextNinetyFive);
  });

  it('respects a shorter half-life by forgetting faster', () => {
    const record = memory({ createdAt: now - 30 * DAY });
    const patient = retentionScore(record, now, { halfLifeMs: 365 * DAY });
    const forgetful = retentionScore(record, now, { halfLifeMs: DAY });
    expect(patient).toBeGreaterThan(forgetful);
  });

  it('returns 0 when every weight is zero rather than dividing by zero', () => {
    const score = retentionScore(memory(), now, {
      importanceWeight: 0,
      recencyWeight: 0,
      usageWeight: 0,
    });
    expect(score).toBe(0);
  });

  it('collapses to importance when only importance is weighted', () => {
    const score = retentionScore(memory({ importance: 0.75, createdAt: 0 }), now, {
      importanceWeight: 1,
      recencyWeight: 0,
      usageWeight: 0,
    });
    expect(score).toBeCloseTo(0.75, 10);
  });
});
