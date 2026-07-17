/**
 * A cancellable delay — the one the service and providers share.
 *
 * A `setTimeout` wrapped so an already-aborted or mid-wait signal rejects the
 * promise instead of leaving a timer to fire into the void. It is injectable
 * everywhere it is used, so tests pass a no-op and take no real time; this is the
 * default a real deployment gets.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted');
}
