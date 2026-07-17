/**
 * The worker — tick processing, retries, dead-lettering, scheduler feed, and the
 * runForever loop. Deterministic: tick is driven with fixed times.
 */

import { describe, expect, it } from 'vitest';
import { TestClock, type Clock } from '@hermes/kernel';
import { Scheduler } from '@hermes/scheduler';
import { Worker } from '../src/worker.js';
import { InMemoryJobQueue } from '../src/queue.js';

describe('construction', () => {
  it('requires a toJob mapper when a scheduler is given', () => {
    expect(
      () =>
        new Worker({ handler: () => Promise.resolve(), scheduler: new Scheduler() }),
    ).toThrow(/toJob/);
  });

  it('defaults to an in-memory queue', () => {
    const worker = new Worker<string>({ handler: () => Promise.resolve() });
    expect(worker.queue).toBeInstanceOf(InMemoryJobQueue);
  });
});

describe('tick', () => {
  it('processes a submitted job and acks it', async () => {
    const seen: string[] = [];
    const worker = new Worker<string>({
      handler: (body) => {
        seen.push(body);
        return Promise.resolve();
      },
    });
    await worker.submit('a');
    const result = await worker.tick(0);
    expect(result).toMatchObject({ claimed: 1, processed: 1, retried: 0, dead: 0 });
    expect(seen).toEqual(['a']);
    expect(worker.queue.stats()).toEqual({ pending: 0, inFlight: 0, dead: 0 });
  });

  it('runs at most `concurrency` jobs per tick', async () => {
    const worker = new Worker<number>({
      handler: () => Promise.resolve(),
      concurrency: 2,
    });
    await worker.submit(1);
    await worker.submit(2);
    await worker.submit(3);
    expect((await worker.tick(0)).processed).toBe(2);
    expect((await worker.tick(0)).processed).toBe(1);
  });

  it('retries a failing job with exponential backoff, then dead-letters it', async () => {
    let calls = 0;
    const worker = new Worker<string>({
      handler: () => {
        calls += 1;
        return Promise.reject(new Error('always fails'));
      },
      maxAttempts: 3,
      backoffMs: 100,
    });
    await worker.submit('a');

    // Attempt 1 fails → retry available at 0 + 100*2^0 = 100.
    expect(await worker.tick(0)).toMatchObject({ processed: 0, retried: 1, dead: 0 });
    expect(await worker.tick(50)).toMatchObject({ claimed: 0 }); // not yet available
    // Attempt 2 fails → retry at 100 + 100*2^1 = 300.
    expect(await worker.tick(100)).toMatchObject({ retried: 1 });
    // Attempt 3 fails and exhausts attempts → dead-lettered.
    expect(await worker.tick(300)).toMatchObject({ retried: 0, dead: 1 });
    expect(calls).toBe(3);
    expect(worker.queue.stats().dead).toBe(1);
  });

  it('retries then succeeds when the handler recovers', async () => {
    let calls = 0;
    const worker = new Worker<string>({
      handler: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('once')) : Promise.resolve();
      },
      backoffMs: 10,
    });
    await worker.submit('a');
    expect(await worker.tick(0)).toMatchObject({ retried: 1 });
    expect(await worker.tick(10)).toMatchObject({ processed: 1 });
    expect(worker.queue.stats()).toEqual({ pending: 0, inFlight: 0, dead: 0 });
  });

  it('handles a non-Error thrown by the handler', async () => {
    const queue = new InMemoryJobQueue<string>();
    // A handler that rejects with a non-Error, to exercise the String(err) branch.
    const handler = (): Promise<void> =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject('a string');
    const worker = new Worker<string>({ queue, handler, maxAttempts: 1 });
    await worker.submit('a');
    await worker.tick(0);
    expect(queue.deadJobs()[0]?.reason).toBe('a string');
  });

  it('passes the attempt number and a signal to the handler', async () => {
    let ctx: { attempts: number; hasSignal: boolean } | undefined;
    const worker = new Worker<string>({
      handler: (_b, c) => {
        ctx = { attempts: c.attempts, hasSignal: c.signal instanceof AbortSignal };
        return Promise.resolve();
      },
    });
    await worker.submit('a');
    await worker.tick(0);
    expect(ctx).toEqual({ attempts: 1, hasSignal: true });
  });
});

describe('scheduler integration', () => {
  it('enqueues due scheduled jobs each tick and processes them', async () => {
    const processed: string[] = [];
    const scheduler = new Scheduler<{ name: string }>();
    scheduler.add(
      {
        id: 'nightly',
        trigger: { kind: 'interval', everyMs: 1000, anchorMs: 0 },
        payload: { name: 'digest' },
      },
      0,
    );

    const worker = new Worker<{ name: string }, { name: string }>({
      handler: (body) => {
        processed.push(body.name);
        return Promise.resolve();
      },
      scheduler,
      toJob: (payload) => payload,
    });

    expect(await worker.tick(500)).toMatchObject({ fired: 0, processed: 0 }); // nothing due yet
    const at1000 = await worker.tick(1000);
    expect(at1000).toMatchObject({ fired: 1, processed: 1 });
    expect(processed).toEqual(['digest']);
  });
});

describe('runForever', () => {
  /** A clock whose sleep resolves immediately, counting ticks and aborting after N. */
  const countingClock = (
    controller: AbortController,
    stopAfter: number,
  ): { clock: Clock; ticks: () => number } => {
    let ticks = 0;
    const clock: Clock = {
      now: () => ticks,
      sleep: () => {
        ticks += 1;
        if (ticks >= stopAfter) controller.abort();
        return Promise.resolve();
      },
    };
    return { clock, ticks: () => ticks };
  };

  it('ticks until the signal aborts', async () => {
    const controller = new AbortController();
    const processed: string[] = [];
    const { clock, ticks } = countingClock(controller, 3);
    const worker = new Worker<string>({
      handler: (b) => {
        processed.push(b);
        return Promise.resolve();
      },
      clock,
    });
    await worker.submit('a');
    await worker.runForever({ pollIntervalMs: 5, signal: controller.signal });
    expect(ticks()).toBe(3);
    expect(processed).toEqual(['a']); // the first tick drained the job
  });

  it('returns when the sleep is aborted mid-wait', async () => {
    const controller = new AbortController();
    const clock: Clock = {
      now: () => 0,
      sleep: () => Promise.reject(new Error('aborted')),
    };
    const worker = new Worker<string>({ handler: () => Promise.resolve(), clock });
    await expect(
      worker.runForever({ signal: controller.signal }),
    ).resolves.toBeUndefined();
  });

  it('does not tick when already aborted', async () => {
    const worker = new Worker<string>({
      handler: () => Promise.resolve(),
      clock: new TestClock(),
    });
    await worker.runForever({ signal: AbortSignal.abort() });
    expect(worker.queue.stats().inFlight).toBe(0);
  });
});
