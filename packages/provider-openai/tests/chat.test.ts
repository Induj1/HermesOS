/**
 * The chat model — request mapping and response parsing, against a fake client.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient, type HttpClient } from '@hermes/tools-http';
import { assistant, system, toolResult, user } from '@hermes/model';
import { OpenAIClient } from '../src/client.js';
import { OpenAIChatModel } from '../src/chat.js';

const completion = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: 'gpt-4o-mini',
    choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...over,
  });

const modelWith = (body: string): { model: OpenAIChatModel; http: FakeHttpClient } => {
  const http = new FakeHttpClient({
    handle: () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    }),
  });
  return {
    model: new OpenAIChatModel({
      client: new OpenAIClient({ http, apiKey: 'k' }),
      model: 'gpt-4o-mini',
      contextWindow: 128000,
    }),
    http,
  };
};

const sentBody = (http: FakeHttpClient): Record<string, unknown> =>
  JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;

describe('info', () => {
  it('declares chat, tools, and the context window', () => {
    const { model } = modelWith(completion());
    expect(model.info).toMatchObject({
      name: 'gpt-4o-mini',
      provider: 'openai',
      contextWindow: 128000,
      supports: { chat: true, tools: true },
    });
  });
});

describe('chat', () => {
  it('maps messages and parses content, stop reason, and usage', async () => {
    const { model, http } = modelWith(completion());
    const result = await model.chat([system('be brief'), user('hi')]);

    expect(result).toMatchObject({
      content: 'hello there',
      stopReason: 'stop',
      model: 'gpt-4o-mini',
    });
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(sentBody(http)).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('passes temperature, max_tokens, and stop', async () => {
    const { model, http } = modelWith(completion());
    await model.chat([user('hi')], { temperature: 0.2, maxTokens: 100, stop: ['\n'] });
    expect(sentBody(http)).toMatchObject({
      temperature: 0.2,
      max_tokens: 100,
      stop: ['\n'],
    });
  });

  it('merges provider-specific extra options', async () => {
    const { model, http } = modelWith(completion());
    await model.chat([user('hi')], { extra: { top_p: 0.9 } });
    expect(sentBody(http)['top_p']).toBe(0.9);
  });

  it('maps finish reasons to stop reasons', async () => {
    for (const [finish, reason] of [
      ['length', 'length'],
      ['tool_calls', 'tool_calls'],
      ['content_filter', 'filtered'],
      ['weird', 'stop'],
    ] as const) {
      const { model } = modelWith(
        completion({ choices: [{ message: { content: '' }, finish_reason: finish }] }),
      );
      expect((await model.chat([user('x')])).stopReason).toBe(reason);
    }
  });

  it('defaults content to empty and omits usage when absent', async () => {
    const { model } = modelWith(
      JSON.stringify({ model: 'm', choices: [{ message: {}, finish_reason: 'stop' }] }),
    );
    const result = await model.chat([user('x')]);
    expect(result.content).toBe('');
    expect(result.usage).toBeUndefined();
  });

  it('throws InvalidRequestError when there are no choices', async () => {
    const { model } = modelWith(JSON.stringify({ model: 'm', choices: [] }));
    await expect(model.chat([user('x')])).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('tool calling', () => {
  it('sends tools and tool_choice and parses tool calls', async () => {
    const body = completion({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'search', arguments: '{"q":"hermes"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { model, http } = modelWith(body);
    const result = await model.chatWithTools(
      [user('find it')],
      [
        {
          name: 'search',
          description: 'search the web',
          parameters: { type: 'object' },
        },
      ],
      { toolChoice: 'required' },
    );

    expect(result.stopReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'search', args: { q: 'hermes' } },
    ]);
    expect(sentBody(http)).toMatchObject({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'search the web',
            parameters: { type: 'object' },
          },
        },
      ],
      tool_choice: 'required',
    });
  });

  it('maps a named tool_choice to the OpenAI shape', async () => {
    const { model, http } = modelWith(completion());
    await model.chatWithTools([user('x')], [{ name: 't', description: 'd' }], {
      toolChoice: { name: 't' },
    });
    expect(sentBody(http)['tool_choice']).toEqual({
      type: 'function',
      function: { name: 't' },
    });
  });

  it('round-trips an assistant tool call and a tool result in the request', async () => {
    const { model, http } = modelWith(completion());
    await model.chat([
      user('search'),
      assistant('', [{ id: 'c1', name: 'search', args: { q: 'x' } }]),
      toolResult('c1', 'a result'),
    ]);
    const messages = sentBody(http)['messages'] as Record<string, unknown>[];
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'a result',
    });
  });

  it('keeps malformed tool-call arguments as a raw string', async () => {
    const body = completion({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{not json' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { model } = modelWith(body);
    expect((await model.chat([user('x')])).toolCalls?.[0]?.args).toBe('{not json');
  });

  it('does not send a tools array when none are given', async () => {
    const { model, http } = modelWith(completion());
    await model.chat([user('x')]);
    expect(sentBody(http)['tools']).toBeUndefined();
  });

  it('does not send tool_choice without tools', async () => {
    const { model, http } = modelWith(completion());
    await model.chatWithTools([user('x')], [], { toolChoice: 'auto' });
    expect(sentBody(http)['tool_choice']).toBeUndefined();
  });
});

describe('edge mappings', () => {
  it('carries a message name through', async () => {
    const { model, http } = modelWith(completion());
    await model.chat([user('hi', 'alice')]);
    const messages = sentBody(http)['messages'] as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ role: 'user', name: 'alice' });
  });

  it('defaults partial usage tokens to zero', async () => {
    const { model } = modelWith(completion({ usage: { prompt_tokens: 7 } }));
    expect((await model.chat([user('x')])).usage).toEqual({
      promptTokens: 7,
      completionTokens: 0,
    });
  });

  it('forwards an abort signal to the client', async () => {
    const { model } = modelWith(completion());
    await expect(
      model.chat([user('x')], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it('omits the context window from info when not given', () => {
    const http = new FakeHttpClient({
      handle: () => ({ status: 200, body: completion() }),
    });
    const model = new OpenAIChatModel({
      client: new OpenAIClient({ http }),
      model: 'm',
    });
    expect('contextWindow' in model.info).toBe(false);
  });

  it('sends a tool with no parameters, and an assistant tool call with no args', async () => {
    const { model, http } = modelWith(completion());
    await model.chatWithTools(
      [user('x'), assistant('', [{ id: 'c', name: 'f', args: undefined }])],
      [{ name: 'f', description: 'd' }],
    );
    const body = sentBody(http);
    expect((body['tools'] as Record<string, unknown>[])[0]).toEqual({
      type: 'function',
      function: { name: 'f', description: 'd' },
    });
    const messages = body['messages'] as Record<string, unknown>[];
    expect(messages[1]).toMatchObject({
      tool_calls: [{ function: { name: 'f', arguments: '{}' } }],
    });
  });

  it('parses an empty tool-call arguments string as an empty object', async () => {
    const body = completion({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c', function: { name: 'f', arguments: '' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { model } = modelWith(body);
    expect((await model.chat([user('x')])).toolCalls?.[0]?.args).toEqual({});
  });

  it('defaults a missing prompt token count to zero', async () => {
    const { model } = modelWith(completion({ usage: { completion_tokens: 4 } }));
    expect((await model.chat([user('x')])).usage).toEqual({
      promptTokens: 0,
      completionTokens: 4,
    });
  });
});

// Type guard the fake as an HttpClient at least once, to keep the import honest.
const _typecheck: HttpClient = new FakeHttpClient({
  handle: () => ({ status: 200, body: '{}' }),
});
void _typecheck;
