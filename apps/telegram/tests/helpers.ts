/**
 * Test doubles shared across the suites: a scripted model that implements the
 * `@hermes/model` contract without a provider, and two trivial tools.
 */

import type { Logger } from '@hermes/kernel';
import type {
  ModelInfo,
  ModelMessage,
  ModelOptions,
  ModelResponse,
  ToolCallingModel,
  ToolCallingOptions,
  ToolDefinition,
} from '@hermes/model';
import { defineTool, s } from '@hermes/tools';

/** A logger that records the messages passed to each level. */
export function spyLogger(): Logger & {
  readonly warns: string[];
  readonly errors: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger & { readonly warns: string[]; readonly errors: string[] } = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warns.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
    child: () => logger,
    warns,
    errors,
  };
  return logger;
}

/** A model that returns a fixed script of responses, one per call. */
export class ScriptedModel implements ToolCallingModel {
  readonly info: ModelInfo = {
    name: 'scripted',
    provider: 'test',
    supports: { chat: true, tools: true, streaming: false },
  };

  readonly calls: {
    readonly withTools: boolean;
    readonly messages: readonly ModelMessage[];
  }[] = [];

  #index = 0;
  readonly #script: readonly ModelResponse[];

  constructor(script: readonly ModelResponse[]) {
    this.#script = script;
  }

  chat(
    messages: readonly ModelMessage[],
    _options?: ModelOptions,
  ): Promise<ModelResponse> {
    this.calls.push({ withTools: false, messages });
    return Promise.resolve(this.#next());
  }

  chatWithTools(
    messages: readonly ModelMessage[],
    _tools: readonly ToolDefinition[],
    _options?: ToolCallingOptions,
  ): Promise<ModelResponse> {
    this.calls.push({ withTools: true, messages });
    return Promise.resolve(this.#next());
  }

  #next(): ModelResponse {
    const response = this.#script[Math.min(this.#index, this.#script.length - 1)];
    this.#index += 1;
    if (response === undefined) throw new Error('ScriptedModel: empty script');
    return response;
  }
}

/** A model whose every call rejects — for exercising the error path. */
export class BrokenModel implements ToolCallingModel {
  readonly info: ModelInfo = {
    name: 'broken',
    provider: 'test',
    supports: { chat: true, tools: true, streaming: false },
  };

  chat(): Promise<ModelResponse> {
    return Promise.reject(new Error('model is down'));
  }

  chatWithTools(): Promise<ModelResponse> {
    return Promise.reject(new Error('model is down'));
  }
}

export function answer(content: string): ModelResponse {
  return { content, stopReason: 'stop', model: 'scripted' };
}

export function toolCall(name: string, args: unknown, id = 'call_1'): ModelResponse {
  return {
    content: '',
    toolCalls: [{ id, name, args }],
    stopReason: 'tool_calls',
    model: 'scripted',
  };
}

/** Echoes its `text` argument straight back. */
export const echoTool = defineTool({
  name: 'echo',
  description: 'Echo the given text back to the caller.',
  input: s.object({ text: s.string() }),
  output: s.string(),
  execute: ({ text }) => Promise.resolve(text),
});

/** Always throws — for exercising failed-observation handling. */
export const boomTool = defineTool({
  name: 'boom',
  description: 'Always fails; used to test tool-failure handling.',
  input: s.object({}),
  output: s.string(),
  execute: () => {
    throw new Error('boom');
  },
});
