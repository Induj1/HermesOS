/**
 * Short-term conversation memory: the last few turns of each chat, verbatim.
 *
 * The memory store gives the agent *semantic* recall (relevant facts from any
 * time); this gives it *recency* — what we were literally just talking about —
 * so follow-ups like "and the second one?" make sense. Kept in memory, capped
 * per chat, and rendered into the system prompt each turn.
 */

import type { AgentRequest } from '@hermes/agent';

export type Role = 'user' | 'assistant';

export interface Turn {
  readonly role: Role;
  readonly content: string;
}

export class ConversationHistory {
  readonly #turns = new Map<string, Turn[]>();
  readonly #limit: number;

  /** `limit` is the number of turns kept per chat (default 8). */
  constructor(limit = 8) {
    this.#limit = Math.max(1, limit);
  }

  /** Append a turn, trimming the chat to the most recent `limit`. */
  add(subject: string, role: Role, content: string): void {
    const text = content.trim();
    if (text === '') return;
    const turns = this.#turns.get(subject) ?? [];
    turns.push({ role, content: text });
    if (turns.length > this.#limit) turns.splice(0, turns.length - this.#limit);
    this.#turns.set(subject, turns);
  }

  /** The recent turns for a chat, oldest first. */
  recent(subject: string): readonly Turn[] {
    return this.#turns.get(subject) ?? [];
  }

  /** Render the recent turns as prompt text, or '' when there are none. */
  render(subject: string): string {
    const turns = this.recent(subject);
    if (turns.length === 0) return '';
    return turns
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Hermes'}: ${turn.content}`)
      .join('\n');
  }
}

/** A systemPrompt function that appends the chat history carried on the request. */
export function systemPromptWithHistory(
  base: string,
): (request: AgentRequest) => string {
  return (request) => {
    const history = request.context?.['history'];
    if (typeof history === 'string' && history.trim() !== '') {
      return `${base}\n\nRecent conversation (for context, most recent last):\n${history}`;
    }
    return base;
  };
}
