/**
 * Health checks — is the process alive, and are its dependencies ready?
 *
 * Two questions an orchestrator asks a service, and they are different:
 *
 * - **Liveness** — is the process itself healthy, or wedged and in need of a
 *   restart? A failing liveness check gets the container killed.
 * - **Readiness** — can the service serve traffic *right now*? Its database,
 *   its model provider, its queue — all reachable? A failing readiness check
 *   pulls the instance out of the load balancer without killing it, so a
 *   transient dependency blip does not trigger a restart loop.
 *
 * A `HealthCheck` names itself, declares which question it answers, and runs to
 * a `CheckOutcome`. A `HealthMonitor` runs a set of them — each under a deadline,
 * concurrently — and aggregates to a single worst-of status plus a per-check
 * report. Timing is driven by an injected `Clock`, so a timeout is exercised by
 * advancing a `TestClock`, never by really waiting.
 */

import type { Clock } from '@hermes/kernel';

/** Health, worst to best. Ordering matters: aggregation takes the worst. */
export type HealthStatus = 'unhealthy' | 'degraded' | 'healthy';

/** Which question a check answers. */
export type CheckKind = 'liveness' | 'readiness';

/** What a single check reports. */
export interface CheckOutcome {
  readonly status: HealthStatus;
  /** A human note — why it is degraded/unhealthy, or a healthy detail. */
  readonly detail?: string;
}

/** A named, kinded health check. */
export interface HealthCheck {
  readonly name: string;
  readonly kind: CheckKind;
  /** Run the check. Should honour `signal` (the monitor aborts on timeout). */
  run(signal: AbortSignal): Promise<CheckOutcome>;
}

/** One check's line in a report. */
export interface CheckReport extends CheckOutcome {
  readonly name: string;
  readonly kind: CheckKind;
  /** How long the check took, by the monitor's clock. */
  readonly durationMs: number;
}

/** The aggregate health of a service. */
export interface HealthReport {
  /** The worst status among the included checks (`healthy` when there are none). */
  readonly status: HealthStatus;
  readonly checks: readonly CheckReport[];
  /** When the report was produced, by the monitor's clock. */
  readonly timestampMs: number;
}

// A module-level unique symbol, so `result === TIMED_OUT` narrows the race
// result to a `CheckOutcome` in the false branch.
const TIMED_OUT: unique symbol = Symbol('health.timeout');

const RANK: Record<HealthStatus, number> = { unhealthy: 0, degraded: 1, healthy: 2 };

/** The worse of two statuses. */
function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Reduce a set of outcomes to the worst status; `healthy` when empty. */
export function aggregate(statuses: readonly HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(worse, 'healthy');
}

/** A healthy outcome, optionally with a note. */
export function healthy(detail?: string): CheckOutcome {
  return detail === undefined ? { status: 'healthy' } : { status: 'healthy', detail };
}

/** A degraded outcome — serving, but impaired. */
export function degraded(detail: string): CheckOutcome {
  return { status: 'degraded', detail };
}

/** An unhealthy outcome — not serving. */
export function unhealthy(detail: string): CheckOutcome {
  return { status: 'unhealthy', detail };
}

/**
 * Build a check from a function. The function may return a `CheckOutcome`, or
 * throw — a thrown error becomes `unhealthy` with the error's message, so a
 * check body can `assert`/`throw` naturally rather than catching everything.
 */
export function check(
  name: string,
  run: (signal: AbortSignal) => Promise<CheckOutcome> | CheckOutcome,
  kind: CheckKind = 'readiness',
): HealthCheck {
  return { name, kind, run: (signal) => Promise.resolve(run(signal)) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MonitorOptions {
  readonly clock: Clock;
  /** Per-check deadline in ms (default 5000). A slow dependency is unhealthy. */
  readonly timeoutMs?: number;
}

export class HealthMonitor {
  readonly #checks: HealthCheck[];
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(checks: readonly HealthCheck[], options: MonitorOptions) {
    this.#checks = [...checks];
    this.#clock = options.clock;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Register another check. */
  add(check: HealthCheck): void {
    this.#checks.push(check);
  }

  /** How many checks are registered. */
  get size(): number {
    return this.#checks.length;
  }

  /**
   * Run the checks and aggregate. With `kind`, only checks of that kind run —
   * so a `/livez` handler passes `'liveness'` and a `/readyz` handler
   * `'readiness'`. Every check runs concurrently, each under the deadline.
   */
  async report(
    options: { kind?: CheckKind; signal?: AbortSignal } = {},
  ): Promise<HealthReport> {
    const selected =
      options.kind === undefined
        ? this.#checks
        : this.#checks.filter((c) => c.kind === options.kind);

    const checks = await Promise.all(
      selected.map((c) => this.#runOne(c, options.signal)),
    );
    return {
      status: aggregate(checks.map((c) => c.status)),
      checks,
      timestampMs: this.#clock.now(),
    };
  }

  async #runOne(check: HealthCheck, parentSignal?: AbortSignal): Promise<CheckReport> {
    const controller = new AbortController();
    const relay = () => {
      controller.abort();
    };
    if (parentSignal !== undefined) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', relay, { once: true });
    }

    const start = this.#clock.now();
    let outcome: CheckOutcome;
    try {
      outcome = await this.#race(check, controller);
    } catch (error) {
      outcome = { status: 'unhealthy', detail: messageOf(error) };
    } finally {
      parentSignal?.removeEventListener('abort', relay);
      // Cancel whichever branch lost the race (the pending sleep, or the check).
      controller.abort();
    }
    return {
      name: check.name,
      kind: check.kind,
      ...outcome,
      durationMs: this.#clock.now() - start,
    };
  }

  async #race(check: HealthCheck, controller: AbortController): Promise<CheckOutcome> {
    // Catch the abort-driven rejection so cancelling the sleep never surfaces as
    // an unhandled rejection; the value is ignored once the race has settled.
    const deadline = this.#clock.sleep(this.#timeoutMs, controller.signal).then(
      (): typeof TIMED_OUT => TIMED_OUT,
      (): typeof TIMED_OUT => TIMED_OUT,
    );
    const result = await Promise.race([check.run(controller.signal), deadline]);
    if (result === TIMED_OUT) {
      return unhealthy(`timed out after ${String(this.#timeoutMs)}ms`);
    }
    return result;
  }
}

/**
 * The HTTP status a health report maps to: `200` while serving (healthy or
 * degraded), `503` when unhealthy. Kept here (not in `@hermes/rest`) so the
 * mapping is a pure function a `/readyz` route composes, with no REST import.
 */
export function httpStatusFor(status: HealthStatus): number {
  return status === 'unhealthy' ? 503 : 200;
}
