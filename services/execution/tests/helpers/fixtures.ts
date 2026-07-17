/**
 * Shared fixtures.
 *
 * Deliberately small, like the planner's. A helper that builds too much makes
 * tests read like configuration rather than like statements about behaviour.
 *
 * The runtime here is a **real** kernel `Runtime` with real tools. The engine's
 * entire claim is that it composes the kernel rather than replacing it, and a
 * fake runtime would let that claim be false while the tests stayed green.
 */

import {
  defineAgent,
  defineTool,
  noopLogger,
  Runtime,
  sequentialIds,
  TestClock,
} from '@hermes/kernel';
import type { AgentContext, Logger } from '@hermes/kernel';
import type { Plan, PlanStep } from '@hermes/planner';
import { toPlanId } from '@hermes/planner';

export const FIXED_NOW = 1_700_000_000_000;

export function step(name: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    name,
    intent: `Do ${name}`,
    capability: { kind: 'tool', name: 'echo' },
    ...overrides,
  };
}

export function plan(steps: readonly PlanStep[], overrides: Partial<Plan> = {}): Plan {
  return {
    id: toPlanId('plan_test'),
    goal: { statement: 'Do the thing' },
    steps,
    strategy: 'test',
    rationale: 'Because the test says so',
    confidence: 1,
    createdAt: FIXED_NOW,
    metadata: {},
    ...overrides,
  };
}

/** What the fixture runtime records about the calls it received. */
export interface Calls {
  /** Every tool invocation, in the order it happened, with its resolved input. */
  readonly log: { tool: string; input: unknown }[];
  /** Force `fail` to throw for these steps, keyed by whatever input it is given. */
  readonly failures: Map<string, Error>;
  /** How many times `flaky` has been called, so a test can make it fail once. */
  counter: { value: number };
}

export interface Fixture {
  readonly runtime: Runtime;
  readonly calls: Calls;
  readonly clock: TestClock;
}

/**
 * A started runtime with the tools these tests need.
 *
 * `systemClock` is not used for the runtime: the scheduler really awaits, and a
 * clock that only moves when told would hang a mission. The `TestClock` here is
 * the *engine's*, so timestamps in checkpoints are exact — the same split the
 * memory service's mission tests make, for the same reason.
 */
export function fixture(
  options: { logger?: Logger; concurrency?: number } = {},
): Fixture {
  const calls: Calls = { log: [], failures: new Map(), counter: { value: 0 } };

  const runtime = Runtime.create({
    ids: sequentialIds(),
    concurrency: options.concurrency ?? 4,
    logger: options.logger ?? noopLogger,
  });

  runtime.use({
    name: 'fixtures',
    setup(ctx) {
      // Returns whatever it was given. The workhorse: it makes a resolved `$from`
      // visible in the next step's input and in the final result.
      ctx.registerTool(
        defineTool<unknown, unknown>({
          name: 'echo',
          description: 'Returns its input',
          execute: (input) => {
            calls.log.push({ tool: 'echo', input });
            return Promise.resolve(input);
          },
        }),
      );

      // Throws on demand, so a test can fail one specific step.
      ctx.registerTool(
        defineTool<{ id?: string } | undefined, never>({
          name: 'fail',
          description: 'Throws',
          execute: (input) => {
            calls.log.push({ tool: 'fail', input });
            const error =
              calls.failures.get(input?.id ?? 'default') ?? new Error('boom');
            return Promise.reject(error);
          },
        }),
      );

      // Fails the first time and succeeds after, for testing the kernel's retry
      // through the envelope.
      ctx.registerTool(
        defineTool<unknown, string>({
          name: 'flaky',
          description: 'Fails once, then works',
          execute: () => {
            calls.counter.value += 1;
            calls.log.push({ tool: 'flaky', input: calls.counter.value });
            if (calls.counter.value === 1)
              return Promise.reject(new Error('first attempt fails'));
            return Promise.resolve('recovered');
          },
        }),
      );

      // Never resolves and ignores its signal. Stands in for badly-behaved work:
      // the kernel's cancellation is cooperative (RFC-0001 §11.1), so a tool
      // like this is what a mission-level timeout actually has to deal with, and
      // it is the only way the envelope never sees the failure the kernel does.
      ctx.registerTool(
        defineTool<unknown, never>({
          name: 'hang',
          description: 'Never returns, and does not honour its signal',
          execute: () => {
            calls.log.push({ tool: 'hang', input: undefined });
            return new Promise<never>(() => {
              /* deliberately never settles */
            });
          },
        }),
      );

      // Runs until cancelled, and honours its signal — what RFC-0001 §11.1
      // expects of long-running work. The contrast with `hang` is the point: an
      // execution can only be cancelled as promptly as its steps cooperate.
      ctx.registerTool(
        defineTool<unknown, never>({
          name: 'waits',
          description: 'Runs until cancelled, then stops',
          execute: (_input, toolCtx) =>
            new Promise<never>((_resolve, reject) => {
              calls.log.push({ tool: 'waits', input: undefined });
              toolCtx.signal.addEventListener(
                'abort',
                () => {
                  reject(new Error('cancelled'));
                },
                {
                  once: true,
                },
              );
            }),
        }),
      );

      // An agent, so the envelope's agent path is exercised against a real one
      // rather than only its tool path.
      ctx.registerAgent(
        defineAgent<{ shout?: string }, string>({
          name: 'shouter',
          description: 'Uppercases what it is given',
          capabilities: ['text'],
          handle: (input: { shout?: string }, ctx2: AgentContext) => {
            calls.log.push({ tool: 'shouter', input });
            // Uses its own tool access, proving the envelope handed the inner
            // agent a real AgentContext rather than a hollow one.
            void ctx2.tools.has('echo');
            return Promise.resolve((input.shout ?? '').toUpperCase());
          },
        }),
      );

      // Declares a validator, so a test can prove the envelope applies it — the
      // one line of kernel dispatch the envelope has to duplicate.
      ctx.registerAgent(
        defineAgent<{ n: number }, number>({
          name: 'doubler',
          description: 'Doubles a number, and insists on getting one',
          input: {
            parse: (input: unknown): { n: number } => {
              // `| undefined` is not decoration: a step with no input really
              // does arrive here as undefined, and a cast that claimed otherwise
              // would turn a clear validator message into a TypeError from
              // inside a property read.
              const raw = input as { n?: unknown } | undefined;
              if (typeof raw?.n !== 'number') {
                throw new TypeError('doubler needs { n: number }');
              }
              return { n: raw.n };
            },
          },
          handle: (input) => Promise.resolve(input.n * 2),
        }),
      );
    },
  });

  return { runtime, calls, clock: new TestClock(FIXED_NOW) };
}

/** A logger that records, for tests that assert on what was reported. */
export function recordingLogger(): {
  logger: Logger;
  messages: { level: string; message: string }[];
} {
  const messages: { level: string; message: string }[] = [];
  const make = (): Logger => ({
    debug: (message: string) => messages.push({ level: 'debug', message }),
    info: (message: string) => messages.push({ level: 'info', message }),
    warn: (message: string) => messages.push({ level: 'warn', message }),
    error: (message: string) => messages.push({ level: 'error', message }),
    child: () => make(),
  });
  return { logger: make(), messages };
}
