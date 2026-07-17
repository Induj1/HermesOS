/**
 * Shared fixtures.
 *
 * Deliberately small. A test helper that builds too much makes tests read like
 * configuration rather than like statements about behaviour.
 */

import {
  noopLogger,
  TestClock,
  sequentialIds,
  toMissionId,
  toTaskId,
} from '@hermes/kernel';
import type { MissionSnapshot, TaskSnapshot } from '@hermes/kernel';
import type { Capability, Goal, Plan, PlanStep } from '../../src/model.js';
import { toPlanId } from '../../src/model.js';
import type { PlanContext } from '../../src/ports/plan-strategy.js';
import { StaticCapabilityCatalog } from '../../src/ports/capability-catalog.js';

export const FIXED_NOW = 1_700_000_000_000;

export function capability(
  name: string,
  overrides: Partial<Capability> = {},
): Capability {
  return {
    kind: 'tool',
    name,
    description: `The ${name} capability`,
    tags: [],
    ...overrides,
  };
}

/** A catalog with the three tools most tests need. */
export function catalogOf(...names: string[]): StaticCapabilityCatalog {
  return new StaticCapabilityCatalog(names.map((name) => capability(name)));
}

export function step(name: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    name,
    intent: `Do ${name}`,
    capability: { kind: 'tool', name: `tool.${name}` },
    ...overrides,
  };
}

export function goal(statement = 'Do the thing', overrides: Partial<Goal> = {}): Goal {
  return { statement, ...overrides };
}

export function plan(steps: readonly PlanStep[], overrides: Partial<Plan> = {}): Plan {
  return {
    id: toPlanId('plan_test'),
    goal: goal(),
    steps,
    strategy: 'test',
    rationale: 'Because the test says so',
    confidence: 1,
    createdAt: FIXED_NOW,
    metadata: {},
    ...overrides,
  };
}

/** A PlanContext with deterministic ids and a clock that does not move. */
export function context(overrides: Partial<PlanContext> = {}): PlanContext {
  const ids = sequentialIds();
  return {
    catalog: catalogOf(),
    clock: new TestClock(FIXED_NOW),
    logger: noopLogger,
    signal: undefined,
    newPlanId: () => toPlanId(ids('plan')),
    ...overrides,
  };
}

/**
 * A task snapshot in whatever state a test needs.
 *
 * Built by hand rather than by running a real mission: a replan is defined over
 * states a live runtime will not hold still in — `running` at the moment the
 * process died is the whole interesting case, and it cannot be observed by
 * driving the kernel normally.
 */
export function taskSnapshot(
  name: string,
  state: TaskSnapshot['state'],
  overrides: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  return {
    id: toTaskId(`task_${name}`),
    missionId: toMissionId('mission_test'),
    name,
    state,
    handler: { kind: 'tool', name: `tool.${name}` },
    input: undefined,
    dependsOn: [],
    priority: 0,
    attempts: state === 'succeeded' || state === 'failed' ? 1 : 0,
    maxAttempts: 1,
    metadata: {},
    createdAt: FIXED_NOW,
    startedAt: undefined,
    finishedAt: undefined,
    result: undefined,
    error: undefined,
    ...overrides,
  };
}

export function missionSnapshot(
  tasks: readonly TaskSnapshot[],
  overrides: Partial<MissionSnapshot> = {},
): MissionSnapshot {
  return {
    id: toMissionId('mission_test'),
    name: 'test-mission',
    goal: 'Do the thing',
    state: 'failed',
    failurePolicy: 'fail-fast',
    metadata: {},
    createdAt: FIXED_NOW,
    finishedAt: FIXED_NOW,
    tasks,
    ...overrides,
  };
}

/** A logger that records, for tests that assert on what was reported. */
export function recordingLogger(): {
  logger: typeof noopLogger;
  messages: { level: string; message: string }[];
} {
  const messages: { level: string; message: string }[] = [];
  const make = (): typeof noopLogger => ({
    debug: (message: string) => messages.push({ level: 'debug', message }),
    info: (message: string) => messages.push({ level: 'info', message }),
    warn: (message: string) => messages.push({ level: 'warn', message }),
    error: (message: string) => messages.push({ level: 'error', message }),
    child: () => make(),
  });
  return { logger: make(), messages };
}
