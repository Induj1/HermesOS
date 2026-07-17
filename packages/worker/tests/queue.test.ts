/**
 * The in-memory job queue.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../src/queue.js';

/** First element, asserting it exists — for concise test reads. */
const first = <T>(a: readonly T[]): T => {
  const x = a[0];
  if (x === undefined) throw new Error('expected a claimed job');
  return x;
};

describe('InMemoryJobQueue', () => {
  it('enqueues with a monotonic id and claims it', async () => {
    const q = new InMemoryJobQueue<string>();
    const id = await q.enqueue('a');
    expect(id).toBe('job-1');
    const claimed = await q.claim(10, 0);
    expect(claimed).toEqual([{ id: 'job-1', body: 'a', attempts: 1 }]);
    expect(q.stats()).toEqual({ pending: 0, inFlight: 1, dead: 0 });
  });

  it('honours a caller id and availability time', async () => {
    const q = new InMemoryJobQueue<string>();
    await q.enqueue('later', { id: 'my-id', availableAtMs: 1000 });
    expect(await q.claim(10, 500)).toEqual([]); // not yet available
    expect((await q.claim(10, 1000)).map((j) => j.id)).toEqual(['my-id']);
  });

  it('claims at most max, earliest-available first', async () => {
    const q = new InMemoryJobQueue<string>();
    await q.enqueue('c', { availableAtMs: 30 });
    await q.enqueue('a', { availableAtMs: 10 });
    await q.enqueue('b', { availableAtMs: 20 });
    const claimed = await q.claim(2, 100);
    expect(claimed.map((j) => j.body)).toEqual(['a', 'b']);
    expect(q.stats().pending).toBe(1);
  });

  it('acks a claimed job, removing it', async () => {
    const q = new InMemoryJobQueue<string>();
    await q.enqueue('a');
    const job = first(await q.claim(1, 0));
    await q.ack(job.id);
    expect(q.stats()).toEqual({ pending: 0, inFlight: 0, dead: 0 });
  });

  it('retries a claimed job back to pending with an availability time', async () => {
    const q = new InMemoryJobQueue<string>();
    await q.enqueue('a');
    const job = first(await q.claim(1, 0));
    await q.retry(job.id, 5000);
    expect(q.stats()).toEqual({ pending: 1, inFlight: 0, dead: 0 });
    expect(await q.claim(1, 1000)).toEqual([]); // not available yet
    const reclaimed = await q.claim(1, 5000);
    expect(reclaimed[0]?.attempts).toBe(2); // attempts accumulate
  });

  it('dead-letters a claimed job with a reason', async () => {
    const q = new InMemoryJobQueue<string>();
    await q.enqueue('a');
    const job = first(await q.claim(1, 0));
    await q.deadLetter(job.id, 'boom');
    expect(q.stats()).toEqual({ pending: 0, inFlight: 0, dead: 1 });
    expect(q.deadJobs()).toEqual([
      { id: 'job-1', body: 'a', attempts: 1, reason: 'boom' },
    ]);
  });

  it('ignores ack/retry/deadLetter for an unknown or un-claimed id', async () => {
    const q = new InMemoryJobQueue<string>();
    await expect(q.ack('nope')).resolves.toBeUndefined();
    await expect(q.retry('nope', 0)).resolves.toBeUndefined();
    await expect(q.deadLetter('nope', 'x')).resolves.toBeUndefined();
    expect(q.stats()).toEqual({ pending: 0, inFlight: 0, dead: 0 });
  });

  it('claims nothing when max is zero', async () => {
    const q = new InMemoryJobQueue<string>();
    await q.enqueue('a');
    expect(await q.claim(0, 0)).toEqual([]);
  });
});
