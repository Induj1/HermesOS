import type { AgentRequest } from '@hermes/agent';
import { describe, expect, it } from 'vitest';
import { ConversationHistory, systemPromptWithHistory } from '../src/conversation.js';

describe('ConversationHistory', () => {
  it('records and renders recent turns, capped to the limit', () => {
    const history = new ConversationHistory(2);
    history.add('a', 'user', 'hi');
    history.add('a', 'assistant', 'hello');
    history.add('a', 'user', 'bye'); // trims the oldest

    expect(history.recent('a')).toHaveLength(2);
    expect(history.render('a')).toBe('Hermes: hello\nUser: bye');
  });

  it('ignores blank content and is empty for unknown chats', () => {
    const history = new ConversationHistory();
    history.add('a', 'user', '   ');
    expect(history.render('a')).toBe('');
    expect(history.render('z')).toBe('');
  });
});

describe('systemPromptWithHistory', () => {
  const prompt = systemPromptWithHistory('BASE');
  const req = (context?: Record<string, unknown>): AgentRequest => ({
    input: 'x',
    ...(context ? { context } : {}),
  });

  it('appends history when present', () => {
    const out = prompt(req({ history: 'User: hi' }));
    expect(out).toContain('BASE');
    expect(out).toContain('User: hi');
  });

  it('returns the base prompt when there is no history', () => {
    expect(prompt(req())).toBe('BASE');
    expect(prompt(req({ history: '   ' }))).toBe('BASE');
  });
});
