/**
 * A deterministic, scriptable chat model — for testing the router (and anything
 * that consumes a `ChatModel`).
 *
 * It answers from a script of outcomes consumed in order, or a fixed outcome, so
 * a test can stand up "a model that is rate-limited, then works", "a model that is
 * permanently down", or "a model that answers X" with no network. It records
 * every call, so a test can assert the router tried the models it should have, in
 * order, and stopped when it should have.
 */

import type {
  ChatModel,
  Model,
  ModelFeatures,
  ModelInfo,
  ModelMessage,
  ModelOptions,
  ModelResponse,
  ToolCallingModel,
  ToolCallingOptions,
  ToolDefinition,
} from '@hermes/model';

/** A scripted outcome: a response to return, or an error to throw. */
export type Outcome = ModelResponse | Error;

export interface FakeChatModelOptions {
  readonly name: string;
  readonly provider: string;
  /** Declared capabilities. Defaults to `{ chat: true, tools: true, streaming: false }`. */
  readonly supports?: ModelFeatures;
  /** Outcomes consumed one per call, in order. Falls back to {@link always} when exhausted. */
  readonly script?: readonly Outcome[];
  /** The outcome when there is no (more) script. Defaults to a canned success. */
  readonly always?: Outcome;
}

export class FakeChatModel implements ToolCallingModel {
  readonly info: ModelInfo;
  /** Every call, in order: `chat` or `chatWithTools`, and the messages. */
  readonly calls: { kind: 'chat' | 'tools'; messages: readonly ModelMessage[] }[] = [];

  readonly #script: Outcome[];
  readonly #always: Outcome;

  constructor(options: FakeChatModelOptions) {
    this.info = {
      name: options.name,
      provider: options.provider,
      supports: options.supports ?? { chat: true, tools: true, streaming: false },
    };
    this.#script = [...(options.script ?? [])];
    this.#always = options.always ?? {
      content: `response from ${options.name}`,
      stopReason: 'stop',
      model: options.name,
    };
  }

  async chat(
    messages: readonly ModelMessage[],
    _options?: ModelOptions,
  ): Promise<ModelResponse> {
    this.calls.push({ kind: 'chat', messages });
    return this.#next();
  }

  async chatWithTools(
    messages: readonly ModelMessage[],
    _tools: readonly ToolDefinition[],
    _options?: ToolCallingOptions,
  ): Promise<ModelResponse> {
    this.calls.push({ kind: 'tools', messages });
    return this.#next();
  }

  #next(): Promise<ModelResponse> {
    const outcome = this.#script.length > 0 ? this.#script.shift() : this.#always;
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome ?? (this.#always as ModelResponse));
  }
}

/** A chat-only model (no `chatWithTools`), for testing capability filtering. */
export function chatOnly(
  options: Omit<FakeChatModelOptions, 'supports'> & { streaming?: boolean },
): ChatModel & Model {
  const full = new FakeChatModel({
    ...options,
    supports: { chat: true, tools: false, streaming: options.streaming ?? false },
  });
  return {
    info: full.info,
    chat: (messages, opts) => full.chat(messages, opts),
  };
}

/** Build a `ModelResponse` with sensible defaults. */
export function response(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return { content: 'ok', stopReason: 'stop', model: 'fake', ...overrides };
}
