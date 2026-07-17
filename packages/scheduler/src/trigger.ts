/**
 * Triggers — the three ways a job recurs, and how to compute its next run.
 *
 * A trigger is compiled once (a cron expression is parsed here, not on every
 * poll) into a {@link CompiledTrigger}, and {@link nextRun} is a pure function of
 * the compiled trigger and a timestamp: "given it is now `afterMs`, when does this
 * next fire, or never again?". Purity is the point — the scheduler's behaviour is
 * a function of the clock it is handed, so it is fully testable with fixed times.
 */

import { nextAfter, parseCron, type Cron } from './cron.js';

export type Trigger =
  /** Fire once, at an absolute time. Never fires again. */
  | { readonly kind: 'once'; readonly atMs: number }
  /** Fire every `everyMs`, aligned to `anchorMs` (default epoch 0). */
  | { readonly kind: 'interval'; readonly everyMs: number; readonly anchorMs?: number }
  /** Fire on a 5-field cron schedule (UTC). */
  | { readonly kind: 'cron'; readonly expression: string };

/** A trigger with any parsing done up front. */
export type CompiledTrigger =
  | { readonly kind: 'once'; readonly atMs: number }
  | { readonly kind: 'interval'; readonly everyMs: number; readonly anchorMs: number }
  | { readonly kind: 'cron'; readonly cron: Cron };

/** Compile a trigger, parsing (and validating) a cron expression up front. */
export function compileTrigger(trigger: Trigger): CompiledTrigger {
  switch (trigger.kind) {
    case 'once':
      return { kind: 'once', atMs: trigger.atMs };
    case 'interval':
      if (trigger.everyMs <= 0) throw new Error('interval everyMs must be > 0');
      return {
        kind: 'interval',
        everyMs: trigger.everyMs,
        anchorMs: trigger.anchorMs ?? 0,
      };
    case 'cron':
      return { kind: 'cron', cron: parseCron(trigger.expression) };
  }
}

/**
 * The next fire time strictly after `afterMs`, or `undefined` if the trigger has
 * no future firing (a `once` whose time has passed).
 */
export function nextRun(trigger: CompiledTrigger, afterMs: number): number | undefined {
  switch (trigger.kind) {
    case 'once':
      return trigger.atMs > afterMs ? trigger.atMs : undefined;
    case 'interval': {
      const elapsed = afterMs - trigger.anchorMs;
      const periods = Math.floor(elapsed / trigger.everyMs) + 1;
      return trigger.anchorMs + periods * trigger.everyMs;
    }
    case 'cron':
      return nextAfter(trigger.cron, afterMs);
  }
}
