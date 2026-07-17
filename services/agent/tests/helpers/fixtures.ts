/**
 * Shared fixtures.
 *
 * ## The fake model is not a compromise
 *
 * `FakeChatModel` implements `@hermes/model`'s `ChatModel` / `ToolCallingModel`
 * exactly — the same interface an Ollama or Claude provider will implement. So a
 * test against it exercises the reasoner through the real contract, and the only
 * thing it does not test is whether a provider honours that contract, which is
 * the provider's test to write.
 *
 * That is the payoff for the contracts being their own package: the reasoning
 * layer is finishable and testable before any provider exists.
 */

import { noopLogger, systemClock, TestClock } from '@hermes/kernel';
import type { Logger } from '@hermes/kernel';
import type {
  ChatModel,
  ModelInfo,
  ModelMessage,
  ModelResponse,
  ToolCallingModel,
  ToolCallingOptions,
  ToolDefinition,
} from '@hermes/model';
import type { AgentContext } from '../../src/context.js';
import type {
  AgentRequest,
  SessionTurn,
  ToolObservation,
  ToolRequest,
} from '../../src/model.js';
import { toSessionId } from '../../src/model.js';
import type {
  AgentExecutor,
  AvailableCapability,
} from '../../src/ports/agent-executor.js';
import type { MemoryAdapter } from '../../src/ports/memory-adapter.js';

export const FIXED_NOW = 1_700_000_000_000;

export function request(
  input: unknown = 'do the thing',
  overrides: Partial<AgentRequest> = {},
): AgentRequest {
  return { input, ...overrides };
}

/** An AgentContext with nothing wired. Enough for a reasoner that only decides. */
export function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: toSessionId('session_test'),
    turn: 1,
    capabilities: [],
    history: [],
    transcript: [],
    clock: new TestClock(FIXED_NOW),
    logger: noopLogger,
    signal: undefined,
    ...overrides,
  };
}

export function capability(
  name: string,
  overrides: Partial<AvailableCapability> = {},
): AvailableCapability {
  return {
    name,
    kind: 'tool',
    description: `The ${name} capability`,
    ...overrides,
  };
}

/** What a fake model will say, in order. One per call. */
export type Scripted = ModelResponse | Error;

export interface FakeModelOptions {
  readonly script: readonly Scripted[];
  readonly supportsTools?: boolean;
  readonly name?: string;
}

/**
 * A model that says what it was told to, in order.
 *
 * Scripted rather than a mock framework: a reasoner test is a statement about
 * what the reasoner does *with an answer*, and an array of answers says that more
 * plainly than a mock configured to return them.
 */
export class FakeChatModel implements ToolCallingModel {
  readonly info: ModelInfo;
  /** Every call it received, so a test can assert on what was actually asked. */
  readonly calls: {
    messages: readonly ModelMessage[];
    tools?: readonly ToolDefinition[];
  }[] = [];

  #next = 0;
  readonly #script: readonly Scripted[];

  constructor(options: FakeModelOptions) {
    this.#script = options.script;
    this.info = {
      name: options.name ?? 'fake-model',
      provider: 'fake',
      supports: { chat: true, tools: options.supportsTools ?? true, streaming: false },
    };
  }

  async chat(
    messages: readonly ModelMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<ModelResponse> {
    this.calls.push({ messages });
    options?.signal?.throwIfAborted();
    return await Promise.resolve(this.#take());
  }

  async chatWithTools(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options?: ToolCallingOptions,
  ): Promise<ModelResponse> {
    this.calls.push({ messages, tools });
    options?.signal?.throwIfAborted();
    return await Promise.resolve(this.#take());
  }

  #take(): ModelResponse {
    const next = this.#script[this.#next];
    this.#next += 1;
    if (next === undefined) {
      throw new Error(
        `FakeChatModel ran out of script after ${String(this.#next - 1)} call(s)`,
      );
    }
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A model that only chats — for testing that the reasoner does not offer it tools. */
export function chatOnlyModel(script: readonly Scripted[]): ChatModel {
  const full = new FakeChatModel({ script, supportsTools: false });
  return {
    info: full.info,
    chat: (messages, options) => full.chat(messages, options),
  };
}

export function response(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    content: 'the answer',
    stopReason: 'stop',
    model: 'fake-model',
    ...overrides,
  };
}

export interface FakeExecutorOptions {
  readonly capabilities?: readonly AvailableCapability[];
  /** Results by tool name. Anything not listed returns `{ ok: true, result: 'ok' }`. */
  readonly results?: Record<string, unknown>;
  /** Tools that should fail, by name, with this message. */
  readonly failures?: Record<string, string>;
}

/**
 * An executor that records what it was asked to run.
 *
 * A stub, and the framework ships no real one for a reason (see
 * `ports/agent-executor.ts`) — so a test's executor is the only kind there is
 * outside a host.
 */
export class FakeExecutor implements AgentExecutor {
  /** Every batch, in order. Batches, not requests: the port promises the batch. */
  readonly batches: (readonly ToolRequest[])[] = [];
  readonly #options: FakeExecutorOptions;

  constructor(options: FakeExecutorOptions = {}) {
    this.#options = options;
  }

  available(): readonly AvailableCapability[] {
    return this.#options.capabilities ?? [];
  }

  async execute(requests: readonly ToolRequest[]): Promise<readonly ToolObservation[]> {
    this.batches.push(requests);
    return await Promise.resolve(
      requests.map((request_): ToolObservation => {
        const failure = this.#options.failures?.[request_.name];
        if (failure !== undefined) {
          return {
            id: request_.id,
            name: request_.name,
            ok: false,
            error: { message: failure },
          };
        }
        return {
          id: request_.id,
          name: request_.name,
          ok: true,
          result: this.#options.results?.[request_.name] ?? 'ok',
        };
      }),
    );
  }
}

/** A memory adapter over a fixed list. Read-only, because the port is. */
export function fakeMemory(contents: readonly string[]): MemoryAdapter {
  return {
    recall: (_subject, _text, options) =>
      Promise.resolve(
        contents.slice(0, options?.limit ?? contents.length).map((content, index) => ({
          memory: {
            id: `mem_${String(index)}`,
            subject: 'ada',
            kind: 'fact',
            content,
            importance: 0.5,
            pinned: false,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
            accessedAt: FIXED_NOW,
            accessCount: 0,
            metadata: {},
          } as never,
          score: 1 - index * 0.1,
          similarity: 1 - index * 0.1,
        })),
      ),
  };
}

export function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    turn: 1,
    agent: 'test',
    decision: { kind: 'answer', content: 'done' },
    at: FIXED_NOW,
    ...overrides,
  };
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

export { systemClock };
