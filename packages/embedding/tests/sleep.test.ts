/**
 * The shared cancellable delay.
 */

import { describe, expect, it } from 'vitest';
import { defaultSleep } from '../src/sleep.js';

describe('defaultSleep', () => {
  it('resolves after the delay', async () => {
    await expect(defaultSleep(1)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(defaultSleep(1000, AbortSignal.abort())).rejects.toThrow();
  });

  it('uses a non-Error abort reason as a synthesized error', async () => {
    await expect(defaultSleep(1000, AbortSignal.abort('stringy'))).rejects.toThrow(
      'aborted',
    );
  });

  it('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    const pending = defaultSleep(10_000, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 2);
    await expect(pending).rejects.toThrow();
  });
});
