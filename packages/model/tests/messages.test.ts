/**
 * Message helpers and error classification.
 *
 * Small surface, and the tests are about the two things that are easy to get
 * wrong and silent when you do: a tool result that cannot be matched to its
 * call, and a usage total that reports zero for "nobody said".
 */

import { describe, expect, it } from 'vitest';
import {
  assistant,
  isTruncated,
  system,
  toolResult,
  totalUsage,
  user,
  wantsTools,
} from '../src/messages.js';
import type { ModelResponse, ToolCall } from '../src/contracts.js';

const call: ToolCall = { id: 'call_1', name: 'search', args: { q: 'hermes' } };

const response = (overrides: Partial<ModelResponse> = {}): ModelResponse => ({
  content: 'hello',
  stopReason: 'stop',
  model: 'test-model',
  ...overrides,
});

describe('constructors', () => {
  it('builds a system message', () => {
    expect(system('be brief')).toEqual({ role: 'system', content: 'be brief' });
  });

  it('builds a user message, with a name only when given one', () => {
    expect(user('hi')).toEqual({ role: 'user', content: 'hi' });
    expect(user('hi', 'ada')).toEqual({ role: 'user', content: 'hi', name: 'ada' });
  });

  it('builds an assistant message carrying tool calls', () => {
    expect(assistant('running that', [call])).toEqual({
      role: 'assistant',
      content: 'running that',
      toolCalls: [call],
    });
  });

  // `toolCalls: []` claims "I considered tools and wanted none", which is a
  // different statement from "no tools were in play" — and some providers reject
  // the empty array outright.
  it.each([
    ['no argument', undefined],
    ['an empty array', [] as readonly ToolCall[]],
  ])('omits toolCalls entirely for %s', (_label, calls) => {
    expect(assistant('plain', calls)).not.toHaveProperty('toolCalls');
  });

  // A tool result that does not say which call it answers cannot be matched once
  // two tools run in parallel, and the failure is silent: the model reads the
  // results in the wrong order and reasons confidently about the wrong thing.
  it('builds a tool result that names the call it answers', () => {
    expect(toolResult('call_1', '42 results')).toEqual({
      role: 'tool',
      content: '42 results',
      toolCallId: 'call_1',
    });
  });

  it('carries a tool name when given one', () => {
    expect(toolResult('call_1', 'ok', 'search')).toMatchObject({ name: 'search' });
  });
});

describe('wantsTools', () => {
  // Providers disagree about whether a response carrying tool calls stops with
  // `tool_calls` or `stop`, and some emit both text and calls. What a caller
  // needs to know is whether there is work to run.
  it('reads the calls rather than the stop reason', () => {
    expect(wantsTools(response({ toolCalls: [call], stopReason: 'stop' }))).toBe(true);
    expect(wantsTools(response({ stopReason: 'tool_calls' }))).toBe(false);
  });

  it.each([
    ['no toolCalls field', undefined],
    ['an empty array', [] as readonly ToolCall[]],
  ])('is false for %s', (_label, toolCalls) => {
    expect(wantsTools(response({ ...(toolCalls ? { toolCalls } : {}) }))).toBe(false);
  });
});

describe('isTruncated', () => {
  // The one stop reason a caller must never treat as an answer: the model was
  // mid-sentence, and the text reads plausibly right up to where it stops.
  it('is true only when the model ran out of room', () => {
    expect(isTruncated(response({ stopReason: 'length' }))).toBe(true);
    expect(isTruncated(response({ stopReason: 'stop' }))).toBe(false);
    expect(isTruncated(response({ stopReason: 'cancelled' }))).toBe(false);
  });
});

describe('totalUsage', () => {
  it('adds up what was reported', () => {
    expect(
      totalUsage([
        { promptTokens: 10, completionTokens: 5 },
        { promptTokens: 3, completionTokens: 7 },
      ]),
    ).toEqual({ promptTokens: 13, completionTokens: 12 });
  });

  // "This cost nothing" and "nobody said what this cost" are different facts,
  // and a budget layer that confused them would under-report silently.
  it.each([
    ['nothing reported any', [undefined, undefined]],
    ['there was nothing to add', []],
  ])('is undefined when %s', (_label, usages) => {
    expect(totalUsage(usages)).toBeUndefined();
  });

  it('ignores the calls that reported nothing', () => {
    expect(totalUsage([{ promptTokens: 10, completionTokens: 5 }, undefined])).toEqual({
      promptTokens: 10,
      completionTokens: 5,
    });
  });

  it('omits cachedTokens when nobody reported any', () => {
    expect(totalUsage([{ promptTokens: 1, completionTokens: 1 }])).not.toHaveProperty(
      'cachedTokens',
    );
  });

  it('sums cachedTokens when anything reported it', () => {
    expect(
      totalUsage([
        { promptTokens: 10, completionTokens: 5, cachedTokens: 8 },
        { promptTokens: 3, completionTokens: 7 },
      ]),
    ).toEqual({ promptTokens: 13, completionTokens: 12, cachedTokens: 8 });
  });
});
