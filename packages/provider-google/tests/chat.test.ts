/**
 * The Gemini chat model — the generateContent bridge and response parsing.
 */

import { describe, expect, it } from 'vitest';
import { FakeHttpClient } from '@hermes/tools-http';
import { assistant, system, toolResult, user } from '@hermes/model';
import { GoogleClient } from '../src/client.js';
import { GoogleChatModel, toGoogleContents } from '../src/chat.js';

const reply = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    modelVersion: 'gemini-2.0-flash',
    candidates: [{ content: { parts: [{ text: 'hi there' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
    ...over,
  });

const modelWith = (body: string): { model: GoogleChatModel; http: FakeHttpClient } => {
  const http = new FakeHttpClient({
    handle: () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    }),
  });
  return {
    model: new GoogleChatModel({
      client: new GoogleClient({ http, apiKey: 'k' }),
      model: 'gemini-2.0-flash',
      contextWindow: 1000000,
    }),
    http,
  };
};

const sent = (http: FakeHttpClient): Record<string, unknown> =>
  JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;

describe('toGoogleContents', () => {
  it('hoists system to systemInstruction and uses user/model roles', () => {
    const { system: sys, contents } = toGoogleContents([
      system('be terse'),
      user('hi'),
      assistant('hello'),
    ]);
    expect(sys).toBe('be terse');
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('maps a tool call to functionCall and a tool result to functionResponse by name', () => {
    const { contents } = toGoogleContents([
      user('search'),
      assistant('', [{ id: 'c1', name: 'search', args: { q: 'x' } }]),
      toolResult('c1', 'a result', 'search'),
    ]);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'search', response: { content: 'a result' } } },
      ],
    });
  });

  it('falls back to the tool call id when no function name is given', () => {
    const { contents } = toGoogleContents([toolResult('call-42', 'r')]);
    expect(contents[0]?.parts[0]).toEqual({
      functionResponse: { name: 'call-42', response: { content: 'r' } },
    });
  });

  it('coalesces adjacent same-role messages', () => {
    const { contents } = toGoogleContents([user('a'), user('b')]);
    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('omits an empty assistant text part and defaults undefined args', () => {
    const { contents } = toGoogleContents([
      assistant('', [{ id: 'a', name: 'f', args: undefined }]),
    ]);
    expect(contents[0]?.parts).toEqual([{ functionCall: { name: 'f', args: {} } }]);
  });
});

describe('chat', () => {
  it('posts to the model path and parses content and usage', async () => {
    const { model, http } = modelWith(reply());
    const result = await model.chat([system('sys'), user('hi')]);
    expect(result).toMatchObject({
      content: 'hi there',
      stopReason: 'stop',
      model: 'gemini-2.0-flash',
    });
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 4 });
    expect(http.requests[0]?.url).toContain('/models/gemini-2.0-flash:generateContent');
    expect(sent(http)).toMatchObject({
      systemInstruction: { parts: [{ text: 'sys' }] },
    });
  });

  it('sends generationConfig for temperature, maxTokens, and stop', async () => {
    const { model, http } = modelWith(reply());
    await model.chat([user('hi')], { temperature: 0.4, maxTokens: 200, stop: ['END'] });
    expect(sent(http)['generationConfig']).toEqual({
      temperature: 0.4,
      maxOutputTokens: 200,
      stopSequences: ['END'],
    });
  });

  it('omits generationConfig and systemInstruction when not needed, and merges extra', async () => {
    const { model, http } = modelWith(reply());
    await model.chat([user('hi')], { extra: { safetySettings: [] } });
    expect('generationConfig' in sent(http)).toBe(false);
    expect('systemInstruction' in sent(http)).toBe(false);
    expect('safetySettings' in sent(http)).toBe(true);
  });

  it('maps finish reasons', async () => {
    for (const [reason, mapped] of [
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'filtered'],
      ['RECITATION', 'filtered'],
      ['STOP', 'stop'],
      ['OTHER', 'stop'],
    ] as const) {
      const { model } = modelWith(
        reply({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }],
        }),
      );
      expect((await model.chat([user('x')])).stopReason).toBe(mapped);
    }
  });

  it('defaults the model name and omits usage when absent', async () => {
    const { model } = modelWith(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
      }),
    );
    const result = await model.chat([user('x')]);
    expect(result.model).toBe('gemini-2.0-flash');
    expect(result.usage).toBeUndefined();
  });

  it('defaults partial usage tokens to zero', async () => {
    const { model } = modelWith(reply({ usageMetadata: { promptTokenCount: 9 } }));
    expect((await model.chat([user('x')])).usage).toEqual({
      promptTokens: 9,
      completionTokens: 0,
    });
  });

  it('throws when there are no candidates', async () => {
    const { model } = modelWith(JSON.stringify({ candidates: [] }));
    await expect(model.chat([user('x')])).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('handles a candidate with no parts', async () => {
    const { model } = modelWith(
      JSON.stringify({ candidates: [{ content: {}, finishReason: 'STOP' }] }),
    );
    expect((await model.chat([user('x')])).content).toBe('');
  });

  it('omits the context window from info when not given', () => {
    const http = new FakeHttpClient({ handle: () => ({ status: 200, body: reply() }) });
    const model = new GoogleChatModel({
      client: new GoogleClient({ http }),
      model: 'm',
    });
    expect('contextWindow' in model.info).toBe(false);
  });

  it('forwards an abort signal', async () => {
    const { model } = modelWith(reply());
    await expect(
      model.chat([user('x')], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe('tool calling', () => {
  it('sends functionDeclarations and parses a functionCall', async () => {
    const body = reply({
      candidates: [
        {
          content: {
            parts: [
              { text: 'calling' },
              { functionCall: { name: 'search', args: { q: 'hermes' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    const { model, http } = modelWith(body);
    const result = await model.chatWithTools(
      [user('find')],
      [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
      { toolChoice: 'required' },
    );

    expect(result.content).toBe('calling');
    expect(result.toolCalls).toEqual([
      { id: 'search', name: 'search', args: { q: 'hermes' } },
    ]);
    expect(result.stopReason).toBe('tool_calls');
    expect(sent(http)).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            { name: 'search', description: 'search', parameters: { type: 'object' } },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    });
  });

  it('maps each tool_choice to a functionCallingConfig mode', async () => {
    const choices = [
      ['auto', { mode: 'AUTO' }],
      ['required', { mode: 'ANY' }],
      ['none', { mode: 'NONE' }],
      [{ name: 't' }, { mode: 'ANY', allowedFunctionNames: ['t'] }],
    ] as const;
    for (const [choice, expected] of choices) {
      const { model, http } = modelWith(reply());
      await model.chatWithTools([user('x')], [{ name: 't', description: 'd' }], {
        toolChoice: choice,
      });
      expect(
        (sent(http)['toolConfig'] as Record<string, unknown>)['functionCallingConfig'],
      ).toEqual(expected);
    }
  });

  it('defaults a tool with no parameters (declaration without parameters)', async () => {
    const { model, http } = modelWith(reply());
    await model.chatWithTools([user('x')], [{ name: 't', description: 'd' }]);
    const decls = (
      sent(http)['tools'] as { functionDeclarations: Record<string, unknown>[] }[]
    )[0]?.functionDeclarations;
    expect(decls?.[0]).toEqual({ name: 't', description: 'd' });
  });

  it('does not send tools when none are given', async () => {
    const { model, http } = modelWith(reply());
    await model.chat([user('x')]);
    expect('tools' in sent(http)).toBe(false);
  });
});
