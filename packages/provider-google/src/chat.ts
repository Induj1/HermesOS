/**
 * The Gemini chat model — `ChatModel`/`ToolCallingModel` over the client.
 *
 * Google's `generateContent` API is a third distinct shape, and this file bridges
 * it:
 *
 * - **Roles are `user` and `model`** (not `assistant`), and the system prompt is a
 *   separate `systemInstruction` field — like Anthropic, system messages are
 *   hoisted, and adjacent same-role messages are coalesced (Gemini also rejects
 *   two `user` turns in a row).
 * - **Content is `parts`.** Text is a `{ text }` part; a tool call is a
 *   `{ functionCall: { name, args } }` part on a `model` message; a tool result is
 *   a `{ functionResponse: { name, response } }` part on a `user` message.
 * - **Tool results are matched by function *name*, not call id.** A Hermes tool
 *   result carries a `toolCallId`; Gemini wants the function's name. A caller
 *   therefore passes the function name as the message's `name` (`toolResult(id,
 *   content, name)`); the id is used as a fallback so nothing is silently lost.
 *
 * Tools go under `tools[0].functionDeclarations`, and options under
 * `generationConfig`.
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
import type { GoogleClient } from './client.js';

export interface GoogleChatModelOptions {
  readonly client: GoogleClient;
  readonly model: string;
  readonly contextWindow?: number;
}

type Part =
  | { readonly text: string }
  | { readonly functionCall: { readonly name: string; readonly args: unknown } }
  | {
      readonly functionResponse: { readonly name: string; readonly response: unknown };
    };

interface Content {
  readonly role: 'user' | 'model';
  readonly parts: Part[];
}

interface GenerateResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly Part[] };
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
  readonly modelVersion?: string;
}

export class GoogleChatModel implements ToolCallingModel {
  readonly info: ModelInfo;
  readonly #client: GoogleClient;
  readonly #model: string;

  constructor(options: GoogleChatModelOptions) {
    this.#client = options.client;
    this.#model = options.model;
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
    const { system, contents } = toGoogleContents(messages);
    const body: Record<string, unknown> = { contents };
    if (system !== '') body['systemInstruction'] = { parts: [{ text: system }] };

    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature !== undefined)
      generationConfig['temperature'] = options.temperature;
    if (options?.maxTokens !== undefined)
      generationConfig['maxOutputTokens'] = options.maxTokens;
    if (options?.stop !== undefined) generationConfig['stopSequences'] = options.stop;
    if (Object.keys(generationConfig).length > 0)
      body['generationConfig'] = generationConfig;

    if (tools !== undefined && tools.length > 0) {
      body['tools'] = [{ functionDeclarations: tools.map(toGoogleFunction) }];
      if (options?.toolChoice !== undefined) {
        const mode = toGoogleToolMode(options.toolChoice);
        if (mode !== undefined) body['toolConfig'] = { functionCallingConfig: mode };
      }
    }
    if (options?.extra !== undefined) Object.assign(body, options.extra);

    const response = await this.#client.post<GenerateResponse>(
      `/models/${encodeURIComponent(this.#model)}:generateContent`,
      body,
      options?.signal,
    );
    return this.#parse(response);
  }

  #parse(response: GenerateResponse): ModelResponse {
    const candidate = response.candidates?.[0];
    if (candidate === undefined) {
      throw new InvalidRequestError(
        this.#client.provider,
        'the response contained no candidates',
      );
    }
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const part of candidate.content?.parts ?? []) {
      if ('text' in part) text += part.text;
      else if ('functionCall' in part) {
        toolCalls.push({
          id: part.functionCall.name,
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
      }
    }
    return {
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toStopReason(candidate.finishReason, toolCalls.length > 0),
      model: response.modelVersion ?? this.#model,
      ...(response.usageMetadata === undefined
        ? {}
        : { usage: toUsage(response.usageMetadata) }),
    };
  }
}

/** Map Hermes messages to Gemini's `{ systemInstruction, contents }`, coalescing roles. */
export function toGoogleContents(messages: readonly ModelMessage[]): {
  system: string;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const out: Content[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    const mapped = toGoogleContent(message);
    const last = out[out.length - 1];
    if (last?.role === mapped.role) {
      last.parts.push(...mapped.parts);
    } else {
      out.push(mapped);
    }
  }

  return { system: systemParts.join('\n\n'), contents: out };
}

function toGoogleContent(message: ModelMessage): Content {
  if (message.role === 'tool') {
    // Gemini matches a function response by name; the caller passes it as `name`.
    const name = message.name ?? message.toolCallId ?? '';
    return {
      role: 'user',
      parts: [{ functionResponse: { name, response: { content: message.content } } }],
    };
  }
  if (message.role === 'assistant') {
    const parts: Part[] = [];
    if (message.content !== '') parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
    }
    return { role: 'model', parts };
  }
  return { role: 'user', parts: [{ text: message.content }] };
}

function toGoogleFunction(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
  };
}

function toGoogleToolMode(
  choice: NonNullable<ToolCallingOptions['toolChoice']>,
): Record<string, unknown> | undefined {
  if (typeof choice === 'object')
    return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  if (choice === 'required') return { mode: 'ANY' };
  if (choice === 'auto') return { mode: 'AUTO' };
  return { mode: 'NONE' };
}

function toStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'filtered';
    default:
      return 'stop';
  }
}

function toUsage(usage: NonNullable<GenerateResponse['usageMetadata']>): TokenUsage {
  return {
    promptTokens: usage.promptTokenCount ?? 0,
    completionTokens: usage.candidatesTokenCount ?? 0,
  };
}
