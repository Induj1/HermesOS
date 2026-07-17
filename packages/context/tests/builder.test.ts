/**
 * The context builder — priority packing under a token budget, deterministically.
 *
 * The estimator is the default ~chars/4 heuristic with a +4 per-message overhead,
 * so token counts in these tests are computed, not magic: a message with content
 * of length L costs `ceil(L/4) + 4`.
 */

import { describe, expect, it } from 'vitest';
import { user, assistant } from '@hermes/model';
import { ContextBuilder, rankMemories, type MemorySnippet } from '../src/builder.js';

// A generous budget so nothing is dropped unless a test forces it.
const big = new ContextBuilder({ maxTokens: 100000, reserveForResponse: 0 });

describe('assembly order and inclusion', () => {
  it('emits system, then a memory block, then history in chronological order', () => {
    const { messages } = big.build({
      system: 'You are Hermes.',
      history: [user('first'), assistant('reply'), user('second')],
      memories: [{ id: 'm1', text: 'fact one', score: 0.9 }],
    });
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]?.content).toBe('You are Hermes.');
    expect(messages[1]?.content).toContain('fact one');
    expect(messages.slice(2).map((m) => m.content)).toEqual([
      'first',
      'reply',
      'second',
    ]);
  });

  it('omits the memory block when there are no memories', () => {
    const { messages, includedMemories } = big.build({
      system: 'S',
      history: [user('hi')],
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(includedMemories).toEqual([]);
  });

  it('omits the system message when none is given', () => {
    const { messages } = big.build({ history: [user('hi')] });
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('treats an empty system string as absent', () => {
    expect(
      big.build({ system: '', history: [user('hi')] }).messages.map((m) => m.role),
    ).toEqual(['user']);
  });

  it('reports the token total including reserved tool tokens', () => {
    const { tokens } = big.build({ system: 'abcd', toolTokens: 50 });
    // system 'abcd' → ceil(4/4)+4 = 5, plus 50 tool tokens
    expect(tokens).toBe(55);
  });

  it('defaults the response reserve to 1024', () => {
    // A 1030-token window with the default 1024 reserve leaves 6 for context —
    // exactly one 'xxxx' message (5).
    const builder = new ContextBuilder({ maxTokens: 1030 });
    const { messages } = builder.build({ history: [user('aaaa'), user('bbbb')] });
    expect(messages.map((m) => m.content)).toEqual(['bbbb']);
  });
});

describe('history trimming', () => {
  it('keeps the most recent messages and drops the oldest when over budget', () => {
    // Each message 'xxxx' costs ceil(4/4)+4 = 5. Budget for 2 messages = 10.
    const builder = new ContextBuilder({ maxTokens: 10, reserveForResponse: 0 });
    const { messages, droppedHistory } = builder.build({
      history: [user('aaaa'), user('bbbb'), user('cccc')],
    });
    expect(messages.map((m) => m.content)).toEqual(['bbbb', 'cccc']); // oldest 'aaaa' dropped
    expect(droppedHistory).toBe(1);
  });

  it('drops all history when even the newest does not fit', () => {
    const builder = new ContextBuilder({ maxTokens: 3, reserveForResponse: 0 });
    const { messages, droppedHistory } = builder.build({
      history: [user('aaaa'), user('bbbb')],
    });
    expect(messages).toEqual([]);
    expect(droppedHistory).toBe(2);
  });

  it('accounts for reserved tool tokens against the history budget', () => {
    // Budget 15, reserve 0, tools 10 → 5 left → exactly one 'xxxx' (5) message.
    const builder = new ContextBuilder({ maxTokens: 15, reserveForResponse: 0 });
    const { messages } = builder.build({
      toolTokens: 10,
      history: [user('aaaa'), user('bbbb')],
    });
    expect(messages.map((m) => m.content)).toEqual(['bbbb']);
  });
});

describe('memory selection', () => {
  it('includes memories by descending score and drops those that do not fit', () => {
    // Budget tuned so only the top memory fits after the system message.
    const builder = new ContextBuilder({ maxTokens: 20, reserveForResponse: 0 });
    const memories: MemorySnippet[] = [
      { id: 'low', text: 'aaaaaaaa', score: 0.1 }, // 8 chars → 2 +1 = 3
      { id: 'high', text: 'bbbbbbbb', score: 0.9 },
      { id: 'mid', text: 'cccccccc', score: 0.5 },
    ];
    const { includedMemories, droppedMemories } = builder.build({
      system: 'aaaaaaaa',
      memories,
    });
    // system costs 2+4 = 6, budget 14; each memory costs 3. All three fit (9)…
    expect(includedMemories).toEqual(['high', 'mid', 'low']); // ranked by score
    expect(droppedMemories).toEqual([]);
  });

  it('drops the lowest-scored memories when the budget is tight', () => {
    const builder = new ContextBuilder({ maxTokens: 8, reserveForResponse: 0 });
    const memories: MemorySnippet[] = [
      { id: 'a', text: 'aaaaaaaaaaaa', score: 0.9 }, // 12 chars → 3 +1 = 4
      { id: 'b', text: 'bbbbbbbbbbbb', score: 0.8 },
      { id: 'c', text: 'cccccccccccc', score: 0.1 },
    ];
    const { includedMemories, droppedMemories } = builder.build({ memories });
    expect(includedMemories).toEqual(['a', 'b']); // 4 + 4 = 8 fits
    expect(droppedMemories).toEqual(['c']);
  });

  it('does not include memories when none fit', () => {
    const builder = new ContextBuilder({ maxTokens: 2, reserveForResponse: 0 });
    const { includedMemories, droppedMemories } = builder.build({
      memories: [{ id: 'x', text: 'aaaaaaaa', score: 1 }],
    });
    expect(includedMemories).toEqual([]);
    expect(droppedMemories).toEqual(['x']);
  });
});

describe('over-budget system', () => {
  it('always includes the system instruction even if it overflows the budget', () => {
    const builder = new ContextBuilder({ maxTokens: 2, reserveForResponse: 0 });
    const { messages, tokens } = builder.build({
      system: 'a very long system instruction indeed',
    });
    expect(messages.map((m) => m.role)).toEqual(['system']);
    expect(tokens).toBeGreaterThan(2); // reported honestly as over budget
  });
});

describe('rankMemories', () => {
  it('orders by descending score, missing scores last, stably', () => {
    const memories: MemorySnippet[] = [
      { id: 'a', text: 'a' },
      { id: 'b', text: 'b', score: 0.5 },
      { id: 'c', text: 'c', score: 0.9 },
      { id: 'd', text: 'd' },
    ];
    expect(rankMemories(memories).map((m) => m.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('is a no-op for an empty list', () => {
    expect(rankMemories([])).toEqual([]);
  });
});
