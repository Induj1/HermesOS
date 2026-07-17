/**
 * The OpenAI chat model — `ChatModel` and `ToolCallingModel` over the client.
 *
 * All the vendor-specific knowledge lives in two translations: Hermes
 * {@link ModelMessage}s and {@link ToolDefinition}s → OpenAI's request shape, and
 * OpenAI's response → a {@link ModelResponse}. Everything else (transport, error
 * classification, retries at the router) is someone else's job, which is why this
 * file is small and has no HTTP in it.
 *
 * The one subtlety is tool calls in both directions: OpenAI carries a tool call's
 * arguments as a *JSON string*, and a `tool` result message references the call by
 * `tool_call_id`. Both are mapped faithfully so a multi-tool turn round-trips.
 */

import type {
  ModelInfo,
  ModelMessage,
  ModelOptions,
  ModelResponse,
  StopReason,
  ToolCall,
  ToolCallingModel,
  ToolCallingOptions,
  ToolDefinition,
  TokenUsage,
} from '@hermes/model';
import { InvalidRequestError } from '@hermes/model';
import type { OpenAIClient } from './client.js';

export interface OpenAIChatModelOptions {
  readonly client: OpenAIClient;
  /** The model id, e.g. `gpt-4o-mini`. */
  readonly model: string;
  /** Total context window, where known — surfaced in `ModelInfo` for the router. */
  readonly contextWindow?: number;
}

interface ChatCompletion {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly RawToolCall[];
    };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly model?: string;
}

interface RawToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export class OpenAIChatModel implements ToolCallingModel {
  readonly info: ModelInfo;
  readonly #client: OpenAIClient;
  readonly #model: string;

  constructor(options: OpenAIChatModelOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.info = {
      name: options.model,
      provider: options.client.provider,
      ...(options.contextWindow === undefined
        ? {}
        : { contextWindow: options.contextWindow }),
      supports: { chat: true, tools: true, streaming: false, structuredOutput: true },
    };
  }

  chat(
    messages: readonly ModelMessage[],
    options?: ModelOptions,
  ): Promise<ModelResponse> {
    return this.#complete(messages, undefined, options);
  }

  chatWithTools(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options?: ToolCallingOptions,
  ): Promise<ModelResponse> {
    return this.#complete(messages, tools, options);
  }

  async #complete(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[] | undefined,
    options?: ToolCallingOptions,
  ): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: messages.map(toOpenAIMessage),
    };
    if (options?.temperature !== undefined) body['temperature'] = options.temperature;
    if (options?.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;
    if (options?.stop !== undefined) body['stop'] = options.stop;
    if (tools !== undefined && tools.length > 0) {
      body['tools'] = tools.map(toOpenAITool);
      if (options?.toolChoice !== undefined)
        body['tool_choice'] = toOpenAIToolChoice(options.toolChoice);
    }
    if (options?.extra !== undefined) Object.assign(body, options.extra);

    const completion = await this.#client.post<ChatCompletion>(
      '/chat/completions',
      body,
      options?.signal,
    );
    return this.#parse(completion);
  }

  #parse(completion: ChatCompletion): ModelResponse {
    const choice = completion.choices?.[0];
    if (choice === undefined) {
      throw new InvalidRequestError(
        this.#client.provider,
        'the response contained no choices',
      );
    }
    const toolCalls = (choice.message?.tool_calls ?? []).map(fromRawToolCall);
    return {
      content: choice.message?.content ?? '',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toStopReason(choice.finish_reason),
      model: completion.model ?? this.#model,
      ...(completion.usage === undefined ? {} : { usage: toUsage(completion.usage) }),
    };
  }
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name !== undefined) out['name'] = message.name;
  if (message.toolCallId !== undefined) out['tool_call_id'] = message.toolCallId;
  if (message.toolCalls !== undefined) {
    out['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  }
  return out;
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  };
}

function toOpenAIToolChoice(
  choice: NonNullable<ToolCallingOptions['toolChoice']>,
): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function fromRawToolCall(raw: RawToolCall): ToolCall {
  let args: unknown;
  try {
    args = raw.function.arguments === '' ? {} : JSON.parse(raw.function.arguments);
  } catch {
    // A model can stream not-quite-valid JSON; hand the raw string through rather
    // than lose the call. The caller's validator is where it gets checked anyway.
    args = raw.function.arguments;
  }
  return { id: raw.id, name: raw.function.name, args };
}

function toStopReason(finish: string | undefined): StopReason {
  switch (finish) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'filtered';
    default:
      return 'stop';
  }
}

function toUsage(usage: NonNullable<ChatCompletion['usage']>): TokenUsage {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
  };
}
