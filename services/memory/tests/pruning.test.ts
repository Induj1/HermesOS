/**
 * Pruning policy.
 *
 * `PruningStrategy.plan` is pure, which is the entire reason these tests need no
 * database for the part that matters most: deciding what to destroy. The
 * plan/apply split (RFC-0002 §8) is what makes the dangerous code testable
 * synchronously and the boring code testable with a fake.
 */

import { describe, expect, it, vi } from 'vitest';
import { TestClock } from '@hermes/kernel';
import type { MemoryRecord } from '../src/model.js';
import { toMemoryId } from '../src/model.js';
import {
  NeverPruneStrategy,
  Pruner,
  RetentionPruningStrategy,
  type PruneReason,
} from '../src/pruning.js';
import type { MemoryRepository } from '../src/repositories/memory-repository.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

let counter = 0;
function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  counter++;
  return {
    id: toMemoryId(`00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`),
    subject: 'ada',
    kind: 'episode',
    content: `Memory ${String(counter)}`,
    sourceConversationId: undefined,
    sourceMessageId: undefined,
    metadata: {},
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: undefined,
    // Old enough to be out of the default 24h grace period, so that a test which
    // is not about grace does not have to think about it.
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    pinned: false,
    expiresAt: undefined,
    forgottenAt: undefined,
    ...overrides,
  };
}

function reasonFor(
  plan: { forget: readonly { id: string; reason: PruneReason }[] },
  record: MemoryRecord,
): PruneReason | undefined {
  return plan.forget.find((entry) => entry.id === record.id)?.reason;
}

describe('RetentionPruningStrategy', () => {
  describe('pass 1: expired', () => {
    it('forgets a memory past its expiry', () => {
      const strategy = new RetentionPruningStrategy();
      const expired = memory({ expiresAt: NOW - DAY, importance: 1 });
      const plan = strategy.plan([expired], 'ada', NOW);

      expect(plan.forget).toHaveLength(1);
      expect(reasonFor(plan, expired)).toBe('expired');
    });

    it('keeps a memory whose expiry has not arrived', () => {
      const strategy = new RetentionPruningStrategy();
      const live = memory({ expiresAt: NOW + DAY, importance: 1 });
      expect(strategy.plan([live], 'ada', NOW).forget).toHaveLength(0);
    });

    it('forgets an expired memory even when pinned', () => {
      // An explicit expiry is the caller being specific, and it outranks the
      // blanket "keep this" that pinning expresses. Otherwise `pinned` becomes a
      // way to accidentally immortalise something declared temporary at birth.
      const strategy = new RetentionPruningStrategy();
      const record = memory({ pinned: true, expiresAt: NOW - 1 });
      expect(reasonFor(strategy.plan([record], 'ada', NOW), record)).toBe('expired');
    });

    it('forgets an expired memory even within the grace period', () => {
      const strategy = new RetentionPruningStrategy();
      const record = memory({ createdAt: NOW - 60_000, expiresAt: NOW - 1 });
      expect(reasonFor(strategy.plan([record], 'ada', NOW), record)).toBe('expired');
    });
  });

  describe('pass 2: decayed', () => {
    it('forgets a memory whose retention has fallen below the floor', () => {
      const strategy = new RetentionPruningStrategy({ minRetention: 0.5 });
      const faded = memory({ importance: 0.01, createdAt: NOW - 3650 * DAY });
      expect(reasonFor(strategy.plan([faded], 'ada', NOW), faded)).toBe('decayed');
    });

    it('never forgets a pinned memory, however far it has decayed', () => {
      // The escape hatch that does not require trusting the scorer. If this ever
      // fails, `pinned` means nothing.
      const strategy = new RetentionPruningStrategy({ minRetention: 0.99 });
      const pinned = memory({
        pinned: true,
        importance: 0,
        createdAt: NOW - 3650 * DAY,
      });
      expect(strategy.plan([pinned], 'ada', NOW).forget).toHaveLength(0);
    });

    it('spares a memory inside the grace period whatever it scores', () => {
      // A memory written minutes ago has no usage history and its importance is
      // a guess — judging it now judges it on the least information the system
      // will ever have.
      const strategy = new RetentionPruningStrategy({ minRetention: 0.99 });
      const fresh = memory({ importance: 0, createdAt: NOW - 60_000 });
      expect(strategy.plan([fresh], 'ada', NOW).forget).toHaveLength(0);
    });

    it('judges a memory once it is out of grace', () => {
      const strategy = new RetentionPruningStrategy({
        minRetention: 0.99,
        graceMs: 1_000,
      });
      const past = memory({ importance: 0, createdAt: NOW - 2_000 });
      expect(reasonFor(strategy.plan([past], 'ada', NOW), past)).toBe('decayed');
    });

    it('keeps a recently read memory that would otherwise decay away', () => {
      const strategy = new RetentionPruningStrategy({ minRetention: 0.4 });
      const ancient = memory({ importance: 0.5, createdAt: NOW - 3650 * DAY });
      const ancientButRead = memory({
        importance: 0.5,
        createdAt: NOW - 3650 * DAY,
        lastAccessedAt: NOW - 60_000,
        accessCount: 20,
      });

      const plan = strategy.plan([ancient, ancientButRead], 'ada', NOW);
      expect(reasonFor(plan, ancient)).toBe('decayed');
      expect(reasonFor(plan, ancientButRead)).toBeUndefined();
    });
  });

  describe('pass 3: over quota', () => {
    it('evicts exactly the overflow, weakest first', () => {
      const strategy = new RetentionPruningStrategy({
        maxPerSubject: 2,
        minRetention: 0, // isolate the quota pass from the decay pass
      });
      const weak = memory({ importance: 0.1 });
      const middling = memory({ importance: 0.5 });
      const strong = memory({ importance: 0.9 });

      const plan = strategy.plan([strong, weak, middling], 'ada', NOW);

      expect(plan.forget).toHaveLength(1);
      expect(reasonFor(plan, weak)).toBe('over-quota');
      expect(plan.kept).toBe(2);
    });

    it('does nothing when the subject is within quota', () => {
      const strategy = new RetentionPruningStrategy({
        maxPerSubject: 10,
        minRetention: 0,
      });
      const records = [memory(), memory(), memory()];
      expect(strategy.plan(records, 'ada', NOW).forget).toHaveLength(0);
    });

    it('does not double-count a memory already condemned as decayed', () => {
      // The counter bug this guards: if an already-doomed memory were counted
      // toward the quota eviction, the loop would stop early and leave the
      // subject over quota.
      const strategy = new RetentionPruningStrategy({
        maxPerSubject: 1,
        minRetention: 0.35,
      });
      const rotten = memory({ importance: 0, createdAt: NOW - 3650 * DAY });
      const okA = memory({ importance: 0.5 });
      const okB = memory({ importance: 0.6 });

      const plan = strategy.plan([rotten, okA, okB], 'ada', NOW);

      expect(reasonFor(plan, rotten)).toBe('decayed');
      expect(reasonFor(plan, okA)).toBe('over-quota');
      expect(plan.kept).toBe(1);
      // Each memory appears once, whatever the reason.
      expect(new Set(plan.forget.map((entry) => entry.id)).size).toBe(
        plan.forget.length,
      );
    });

    it('leaves a subject over quota rather than evicting pinned memories', () => {
      // Correct by design: a quota must not override an explicit "never forget
      // this". Documented in the strategy, and pinned here so it stays true.
      const strategy = new RetentionPruningStrategy({
        maxPerSubject: 1,
        minRetention: 0,
      });
      const records = [
        memory({ pinned: true }),
        memory({ pinned: true }),
        memory({ pinned: true }),
      ];
      const plan = strategy.plan(records, 'ada', NOW);
      expect(plan.forget).toHaveLength(0);
      expect(plan.kept).toBe(3);
    });
  });

  describe('bookkeeping', () => {
    it('ignores already-forgotten memories', () => {
      const strategy = new RetentionPruningStrategy({ minRetention: 0.99 });
      const tombstone = memory({ importance: 0, forgottenAt: NOW - DAY });
      const plan = strategy.plan([tombstone], 'ada', NOW);
      expect(plan.forget).toHaveLength(0);
      expect(plan.evaluated).toBe(0);
    });

    it('reports kept + forgotten = evaluated', () => {
      const strategy = new RetentionPruningStrategy({
        maxPerSubject: 2,
        minRetention: 0,
      });
      const records = [memory(), memory(), memory(), memory()];
      const plan = strategy.plan(records, 'ada', NOW);
      expect(plan.kept + plan.forget.length).toBe(plan.evaluated);
      expect(plan.evaluated).toBe(4);
    });

    it('carries a reason and content for every condemned memory', () => {
      // The plan is what a host logs or shows before approving a destructive
      // run, so "which memory, and why" has to be in it.
      const strategy = new RetentionPruningStrategy({ minRetention: 0.99 });
      const doomed = memory({ importance: 0, content: 'Ate a sandwich' });
      const [entry] = strategy.plan([doomed], 'ada', NOW).forget;

      expect(entry).toBeDefined();
      expect(entry?.content).toBe('Ate a sandwich');
      expect(entry?.reason).toBe('decayed');
      expect(entry?.score).toBeGreaterThanOrEqual(0);
    });

    it('plans nothing for an empty subject', () => {
      const plan = new RetentionPruningStrategy().plan([], 'ada', NOW);
      expect(plan).toMatchObject({ subject: 'ada', forget: [], kept: 0, evaluated: 0 });
    });
  });
});

describe('NeverPruneStrategy', () => {
  it('forgets nothing, whatever the input', () => {
    const records = [
      memory({ importance: 0, createdAt: 0 }),
      memory({ expiresAt: NOW - 10 * DAY }),
    ];
    const plan = new NeverPruneStrategy().plan(records, 'ada', NOW);
    expect(plan.forget).toHaveLength(0);
    expect(plan.kept).toBe(2);
  });
});

describe('Pruner', () => {
  function fakeRepository(records: readonly MemoryRecord[]) {
    return {
      list: vi.fn().mockResolvedValue(records),
      forget: vi.fn().mockResolvedValue(records.length),
    } as unknown as MemoryRepository & {
      list: ReturnType<typeof vi.fn>;
      forget: ReturnType<typeof vi.fn>;
    };
  }

  it('soft-deletes what the plan condemns', async () => {
    const doomed = memory({ importance: 0, createdAt: NOW - 3650 * DAY });
    const repository = fakeRepository([doomed]);
    const pruner = new Pruner(repository, new TestClock(NOW), {
      strategy: new RetentionPruningStrategy({ minRetention: 0.99 }),
    });

    const plan = await pruner.prune('ada');

    expect(plan.forget).toHaveLength(1);
    expect(repository.forget).toHaveBeenCalledWith([doomed.id]);
  });

  it('writes nothing in dry-run mode', async () => {
    // The right way to introduce pruning to a database that matters: run it dry
    // and read the logs first. If this fails, that promise is broken.
    const doomed = memory({ importance: 0, createdAt: NOW - 3650 * DAY });
    const repository = fakeRepository([doomed]);
    const pruner = new Pruner(repository, new TestClock(NOW), {
      strategy: new RetentionPruningStrategy({ minRetention: 0.99 }),
      dryRun: true,
    });

    const plan = await pruner.prune('ada');

    expect(plan.forget).toHaveLength(1);
    expect(repository.forget).not.toHaveBeenCalled();
  });

  it('does not call forget when there is nothing to forget', async () => {
    const repository = fakeRepository([memory({ importance: 1, createdAt: NOW })]);
    const pruner = new Pruner(repository, new TestClock(NOW));

    await pruner.prune('ada');

    expect(repository.forget).not.toHaveBeenCalled();
  });

  it('plan() never writes', async () => {
    const repository = fakeRepository([memory({ importance: 0, createdAt: 0 })]);
    const pruner = new Pruner(repository, new TestClock(NOW), {
      strategy: new RetentionPruningStrategy({ minRetention: 0.99 }),
    });

    await pruner.plan('ada');

    expect(repository.forget).not.toHaveBeenCalled();
  });

  it('reads time from the injected clock, not the wall clock', async () => {
    // The kernel's Clock is injectable so that time is deterministic in tests
    // (RFC-0001 §12). A pruner reading Date.now() would make eviction depend on
    // when the suite ran.
    const clock = new TestClock(NOW);
    // importance 0.5 contributes a floor of 0.5 * 0.5 = 0.25 to retention, so a
    // 0.3 threshold is crossed by recency alone as it decays — which is exactly
    // the variable under test.
    const record = memory({ importance: 0.5, createdAt: NOW - 10 * DAY });
    const repository = fakeRepository([record]);
    const pruner = new Pruner(repository, clock, {
      strategy: new RetentionPruningStrategy({
        minRetention: 0.3,
        halfLifeMs: 100 * DAY,
      }),
    });

    expect((await pruner.prune('ada')).forget).toHaveLength(0);

    // Move the clock, not the data: the same record now decays past the floor.
    await clock.advance(2_000 * DAY);
    expect((await pruner.prune('ada')).forget).toHaveLength(1);
  });
});
