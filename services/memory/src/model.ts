/**
 * The memory service's domain types — plain, serialisable data.
 *
 * Two conventions here are load bearing, and both are inherited from the kernel
 * rather than invented:
 *
 * 1. **Ids are branded strings.** `Brand` is imported from `@hermes/kernel`'s
 *    public API, so a `MemoryId` cannot be passed where a `ConversationId`
 *    belongs. The brand is erased at runtime; these are ordinary strings.
 *
 * 2. **Timestamps are epoch milliseconds, not Date.** The kernel's snapshots,
 *    `Clock.now()`, and every event payload use `number`, and a service that
 *    spoke `Date` at its edges would translate on every call and lose the ability
 *    to be driven by `TestClock`. Postgres stores `timestamptz`; the repository
 *    layer converts at the SQL boundary and nowhere else.
 */

import type { Brand } from '@hermes/kernel';

export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type MemoryId = Brand<string, 'MemoryId'>;

export function toConversationId(raw: string): ConversationId {
  return raw as ConversationId;
}

export function toMessageId(raw: string): MessageId {
  return raw as MessageId;
}

export function toMemoryId(raw: string): MemoryId {
  return raw as MemoryId;
}

/**
 * Who this memory belongs to, from the host's point of view: a Telegram chat id,
 * a user id, "cli". Opaque on purpose — the memory service has no user model and
 * must not grow one. Every read is scoped by it, so it is also the unit of
 * isolation: two subjects never see each other's memories.
 */
export type Subject = string;

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * What kind of thing a memory is. The taxonomy is small and closed because the
 * scorer and the pruner both branch on it (see `importance.ts`), and an open
 * vocabulary would make their weights unfalsifiable.
 *
 * fact        durable, subject-scoped truth ("their sister is called Mara")
 * preference  a standing instruction ("always brief me at 07:00")
 * episode     something that happened, with a time ("cancelled the dentist")
 * summary     compressed from other memories or a transcript
 * task        an intention not yet discharged ("owes Sam a reply")
 */
export type MemoryKind = 'fact' | 'preference' | 'episode' | 'summary' | 'task';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'episode',
  'summary',
  'task',
];

export interface Conversation {
  readonly id: ConversationId;
  readonly subject: Subject;
  readonly title: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | undefined;
}

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  /** Dense and 1-based within the conversation. Transcript order is by this, never by time. */
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface MemoryRecord {
  readonly id: MemoryId;
  readonly subject: Subject;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sourceConversationId: ConversationId | undefined;
  readonly sourceMessageId: MessageId | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** [0,1], written by an {@link ImportanceScorer}. */
  readonly importance: number;
  readonly accessCount: number;
  readonly lastAccessedAt: number | undefined;
  /** Exempt from pruning, unconditionally. */
  readonly pinned: boolean;
  readonly expiresAt: number | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set by pruning. A soft delete; reads filter these out. */
  readonly forgottenAt: number | undefined;
}

/** A memory with the score that retrieved it, and why. */
export interface ScoredMemory {
  readonly memory: MemoryRecord;
  /** Final rank score. Composition depends on the retrieval mode used. */
  readonly score: number;
  /** Cosine similarity in [-1,1], or undefined for a non-semantic retrieval. */
  readonly similarity: number | undefined;
}

export interface NewConversation {
  readonly subject: Subject;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A message to append. `seq` is assigned by the repository, never by the caller. */
export interface NewMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface NewMemory {
  readonly subject: Subject;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sourceConversationId?: ConversationId;
  readonly sourceMessageId?: MessageId;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Omit to let the configured {@link ImportanceScorer} decide. */
  readonly importance?: number;
  readonly pinned?: boolean;
  readonly expiresAt?: number;
}
