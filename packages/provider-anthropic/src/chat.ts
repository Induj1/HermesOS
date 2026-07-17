/**
 * The Anthropic chat model — `ChatModel`/`ToolCallingModel` over the client.
 *
 * Anthropic's Messages API differs from OpenAI's in three ways this file has to
 * bridge, and they are the whole of its complexity:
 *
 * 1. **The system prompt is hoisted.** Anthropic takes `system` as a top-level
 *    field, not a message with `role: 'system'`. System messages are collected out
 *    of the list and concatenated.
 * 2. **Content is blocks.** A tool call is a `tool_use` block on an assistant
 *    message; a tool result is a `tool_result` block on a *user* message. Plain
 *    text is a `text` block. Everything is normalised to a block array.
 * 3. **Roles must alternate.** Adjacent messages that map to the same role
 *    (several tool results in a turn, a tool result then user text) are coalesced
 *    into one message, because Anthropic rejects two user messages in a row.
 *
 * `max_tokens` is also *required* by Anthropic, so a default is supplied when the
 * caller gives none.
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
import type { AnthropicClient } from './client.js';

/** Anthropic requires `max_tokens`; this is used when the caller sets none. */
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicChatModelOptions {
  readonly client: AnthropicClient;
  readonly model: string;
  readonly contextWindow?: number;
  /** Default `max_tokens` when a request sets none. Default 4096. */
  readonly maxTokens?: number;
}

type Block =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string;
    };

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: Block[];
}

interface MessagesResponse {
  readonly content?: readonly Block[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly model?: string;
}

export class AnthropicChatModel implements ToolCallingModel {
  readonly info: ModelInfo;
  readonly #client: AnthropicClient;
  readonly #model: string;
  readonly #defaultMaxTokens: number;

  constructor(options: AnthropicChatModelOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.info = {
      name: options.model,
      provider: options.client.provider,
      ...(options.contextWindow === undefined
        ? {}
        : { contextWindow: options.contextWindow }),
      supports: { chat: true, tools: true, streaming: false },
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
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens ?? this.#defaultMaxTokens,
    };
    if (system !== '') body['system'] = system;
    if (options?.temperature !== undefined) body['temperature'] = options.temperature;
    if (options?.stop !== undefined) body['stop_sequences'] = options.stop;
    if (tools !== undefined && tools.length > 0) {
      body['tools'] = tools.map(toAnthropicTool);
      if (options?.toolChoice !== undefined) {
        const choice = toAnthropicToolChoice(options.toolChoice);
        if (choice !== undefined) body['tool_choice'] = choice;
      }
    }
    if (options?.extra !== undefined) Object.assign(body, options.extra);

    const response = await this.#client.post<MessagesResponse>(
      '/messages',
      body,
      options?.signal,
    );
    return this.#parse(response);
  }

  #parse(response: MessagesResponse): ModelResponse {
    if (response.content === undefined) {
      throw new InvalidRequestError(
        this.#client.provider,
        'the response contained no content',
      );
    }
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use')
        toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
    return {
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toStopReason(response.stop_reason),
      model: response.model ?? this.#model,
      ...(response.usage === undefined ? {} : { usage: toUsage(response.usage) }),
    };
  }
}

/** Map Hermes messages to Anthropic's `{ system, messages }`, coalescing roles. */
export function toAnthropicMessages(messages: readonly ModelMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    const mapped = toAnthropicMessage(message);
    const last = out[out.length - 1];
    if (last?.role === mapped.role) {
      last.content.push(...mapped.content);
    } else {
      out.push(mapped);
    }
  }

  return { system: systemParts.join('\n\n'), messages: out };
}

function toAnthropicMessage(message: ModelMessage): AnthropicMessage {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? '',
          content: message.content,
        },
      ],
    };
  }
  if (message.role === 'assistant') {
    const content: Block[] = [];
    if (message.content !== '') content.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.args ?? {},
      });
    }
    return { role: 'assistant', content };
  }
  return { role: 'user', content: [{ type: 'text', text: message.content }] };
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: 'object' },
  };
}

function toAnthropicToolChoice(
  choice: NonNullable<ToolCallingOptions['toolChoice']>,
): unknown {
  if (typeof choice === 'object') return { type: 'tool', name: choice.name };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'auto') return { type: 'auto' };
  // 'none' has no Anthropic equivalent short of omitting tools; drop it.
  return undefined;
}

function toStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

function toUsage(usage: NonNullable<MessagesResponse['usage']>): TokenUsage {
  return {
    promptTokens: usage.input_tokens ?? 0,
    completionTokens: usage.output_tokens ?? 0,
  };
}
