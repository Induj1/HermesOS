/**
 * The Anthropic chat model — the message-shape bridge and response parsing.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient } from '@hermes/tools-http';
import { assistant, system, toolResult, user } from '@hermes/model';
import { AnthropicClient } from '../src/client.js';
import { AnthropicChatModel, toAnthropicMessages } from '../src/chat.js';

const reply = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'hi there' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 3 },
    ...over,
  });

const modelWith = (
  body: string,
): { model: AnthropicChatModel; http: FakeHttpClient } => {
  const http = new FakeHttpClient({
    handle: () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    }),
  });
  return {
    model: new AnthropicChatModel({
      client: new AnthropicClient({ http, apiKey: 'k' }),
      model: 'claude-sonnet-4-5',
      contextWindow: 200000,
    }),
    http,
  };
};

const sent = (http: FakeHttpClient): Record<string, unknown> =>
  JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;

describe('toAnthropicMessages', () => {
  it('hoists system messages to a top-level field', () => {
    const { system: sys, messages } = toAnthropicMessages([
      system('be terse'),
      system('and kind'),
      user('hi'),
    ]);
    expect(sys).toBe('be terse\n\nand kind');
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('maps a tool call to a tool_use block and a tool result to a user tool_result', () => {
    const { messages } = toAnthropicMessages([
      user('search'),
      assistant('let me look', [{ id: 'c1', name: 'search', args: { q: 'x' } }]),
      toolResult('c1', 'a result'),
    ]);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a result' }],
    });
  });

  it('coalesces adjacent same-role messages (two tool results in a turn)', () => {
    const { messages } = toAnthropicMessages([
      assistant('', [
        { id: 'a', name: 'f', args: {} },
        { id: 'b', name: 'g', args: {} },
      ]),
      toolResult('a', 'ra'),
      toolResult('b', 'rb'),
    ]);
    // The two tool results merge into one user message with two blocks.
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
      { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
    ]);
  });

  it('omits an empty assistant text block and defaults undefined args to {}', () => {
    const { messages } = toAnthropicMessages([
      assistant('', [{ id: 'a', name: 'f', args: undefined }]),
    ]);
    expect(messages[0]?.content).toEqual([
      { type: 'tool_use', id: 'a', name: 'f', input: {} },
    ]);
  });

  it('defaults a tool message with no id to an empty tool_use_id', () => {
    const { messages } = toAnthropicMessages([{ role: 'tool', content: 'r' }]);
    expect(messages[0]?.content).toEqual([
      { type: 'tool_result', tool_use_id: '', content: 'r' },
    ]);
  });
});

describe('chat', () => {
  it('sends model, messages, and a default max_tokens; parses the reply', async () => {
    const { model, http } = modelWith(reply());
    const result = await model.chat([system('sys'), user('hi')]);
    expect(result).toMatchObject({
      content: 'hi there',
      stopReason: 'stop',
      model: 'claude-sonnet-4-5',
    });
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3 });
    expect(sent(http)).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: 'sys',
    });
  });

  it('honours a caller max_tokens, temperature, and stop_sequences', async () => {
    const { model, http } = modelWith(reply());
    await model.chat([user('hi')], {
      maxTokens: 100,
      temperature: 0.3,
      stop: ['STOP'],
    });
    expect(sent(http)).toMatchObject({
      max_tokens: 100,
      temperature: 0.3,
      stop_sequences: ['STOP'],
    });
  });

  it('omits system when there is none, and merges extra', async () => {
    const { model, http } = modelWith(reply());
    await model.chat([user('hi')], { extra: { top_k: 5 } });
    expect('system' in sent(http)).toBe(false);
    expect(sent(http)['top_k']).toBe(5);
  });

  it('maps stop reasons', async () => {
    for (const [reason, mapped] of [
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['end_turn', 'stop'],
      ['other', 'stop'],
    ] as const) {
      const { model } = modelWith(reply({ stop_reason: reason }));
      expect((await model.chat([user('x')])).stopReason).toBe(mapped);
    }
  });

  it('defaults the model name and omits usage when absent', async () => {
    const { model } = modelWith(
      JSON.stringify({
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
      }),
    );
    const result = await model.chat([user('x')]);
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.usage).toBeUndefined();
  });

  it('throws when the response has no content', async () => {
    const { model } = modelWith(JSON.stringify({ stop_reason: 'end_turn' }));
    await expect(model.chat([user('x')])).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('defaults partial usage tokens to zero (either side)', async () => {
    const a = modelWith(reply({ usage: { input_tokens: 7 } }));
    expect((await a.model.chat([user('x')])).usage).toEqual({
      promptTokens: 7,
      completionTokens: 0,
    });
    const b = modelWith(reply({ usage: { output_tokens: 4 } }));
    expect((await b.model.chat([user('x')])).usage).toEqual({
      promptTokens: 0,
      completionTokens: 4,
    });
  });

  it('omits the context window from info when not given', () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: reply() }) });
    const model = new AnthropicChatModel({
      client: new AnthropicClient({ http }),
      model: 'm',
    });
    expect('contextWindow' in model.info).toBe(false);
  });

  it('forwards an abort signal to the client', async () => {
    const { model } = modelWith(reply());
    await expect(
      model.chat([user('x')], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe('tool calling', () => {
  it('sends tools and parses tool_use blocks', async () => {
    const body = reply({
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'hermes' } },
      ],
      stop_reason: 'tool_use',
    });
    const { model, http } = modelWith(body);
    const result = await model.chatWithTools(
      [user('find')],
      [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
      { toolChoice: 'required' },
    );

    expect(result.content).toBe('calling');
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'search', args: { q: 'hermes' } },
    ]);
    expect(result.stopReason).toBe('tool_calls');
    expect(sent(http)).toMatchObject({
      tools: [
        { name: 'search', description: 'search', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'any' },
    });
  });

  it('maps each tool_choice form', async () => {
    const choices = [
      ['auto', { type: 'auto' }],
      ['required', { type: 'any' }],
      [{ name: 't' }, { type: 'tool', name: 't' }],
    ] as const;
    for (const [choice, expected] of choices) {
      const { model, http } = modelWith(reply());
      await model.chatWithTools([user('x')], [{ name: 't', description: 'd' }], {
        toolChoice: choice,
      });
      expect(sent(http)['tool_choice']).toEqual(expected);
    }
  });

  it('drops tool_choice "none" (no Anthropic equivalent)', async () => {
    const { model, http } = modelWith(reply());
    await model.chatWithTools([user('x')], [{ name: 't', description: 'd' }], {
      toolChoice: 'none',
    });
    expect('tool_choice' in sent(http)).toBe(false);
  });

  it('defaults a tool with no parameters to an object schema', async () => {
    const { model, http } = modelWith(reply());
    await model.chatWithTools([user('x')], [{ name: 't', description: 'd' }]);
    expect(
      (sent(http)['tools'] as Record<string, unknown>[])[0]?.['input_schema'],
    ).toEqual({ type: 'object' });
  });

  it('does not send tools when none are given', async () => {
    const { model, http } = modelWith(reply());
    await model.chat([user('x')]);
    expect('tools' in sent(http)).toBe(false);
  });
});

describe('info', () => {
  it('declares chat and tools with the context window', () => {
    const { model } = modelWith(reply());
    expect(model.info).toMatchObject({
      provider: 'anthropic',
      contextWindow: 200000,
      supports: { chat: true, tools: true, streaming: false },
    });
  });
});
