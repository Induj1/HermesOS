/**
 * Row → domain mapping. The only place that knows what the driver hands back.
 *
 * Three conversions matter here, and each is a bug that would otherwise be
 * silent:
 *
 * 1. **timestamptz → epoch ms.** `pg` parses timestamptz into a `Date`; the
 *    domain speaks `number` (model.ts). Converting in one place is what keeps
 *    `Date` from leaking into types the kernel's `Clock` is supposed to drive.
 *
 * 2. **bigint → number.** `pg` returns int8 as a *string*, because int8's range
 *    exceeds what a double holds exactly. It does not throw; it hands back
 *    `"3"`, and `"3" + 1` is `"31"`. Every int8 column (`seq`, `message_count`)
 *    goes through `toNumber` for that reason. The overflow this guards against
 *    needs 9 quadrillion messages in one conversation, so `Number` is safe here
 *    in a way it would not be for, say, a snowflake id.
 *
 * 3. **NULL → undefined.** The domain uses `undefined` for absence, as the
 *    kernel's snapshots do. `null` would be a second kind of nothing that every
 *    consumer has to check for separately.
 */

import type {
  Conversation,
  ConversationId,
  MemoryId,
  MemoryKind,
  Message,
  MessageId,
  MessageRole,
  MemoryRecord,
} from '../model.js';
import { toConversationId, toMemoryId, toMessageId } from '../model.js';
import type { QueryRow } from '../db/database.js';

export interface ConversationRow extends QueryRow {
  id: string;
  subject: string;
  title: string | null;
  metadata: Record<string, unknown>;
  message_count: string | number;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface MessageRow extends QueryRow {
  id: string;
  conversation_id: string;
  seq: string | number;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface MemoryRow extends QueryRow {
  id: string;
  subject: string;
  kind: string;
  content: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  metadata: Record<string, unknown>;
  importance: number;
  access_count: number;
  last_accessed_at: Date | null;
  pinned: boolean;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  forgotten_at: Date | null;
}

/** Every column of memory_record, in a fixed order, prefixed for joins. */
export const MEMORY_COLUMNS = (alias = 'm'): string =>
  [
    'id',
    'subject',
    'kind',
    'content',
    'source_conversation_id',
    'source_message_id',
    'metadata',
    'importance',
    'access_count',
    'last_accessed_at',
    'pinned',
    'expires_at',
    'created_at',
    'updated_at',
    'forgotten_at',
  ]
    .map((column) => `${alias}.${column}`)
    .join(', ');

export function mapConversation(row: ConversationRow): Conversation {
  return {
    id: toConversationId(row.id),
    subject: row.subject,
    title: row.title ?? undefined,
    metadata: row.metadata,
    messageCount: toNumber(row.message_count),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    closedAt: toEpoch(row.closed_at),
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: toMessageId(row.id),
    conversationId: toConversationId(row.conversation_id),
    seq: toNumber(row.seq),
    // The CHECK constraint on message.role is what makes this cast honest: the
    // database cannot hold a role outside the union. Validating again here would
    // be asserting that Postgres enforces its own constraints.
    role: row.role as MessageRole,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at.getTime(),
  };
}

export function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: toMemoryId(row.id),
    subject: row.subject,
    kind: row.kind as MemoryKind, // See mapMessage: guarded by a CHECK constraint.
    content: row.content,
    sourceConversationId: row.source_conversation_id
      ? toConversationId(row.source_conversation_id)
      : undefined,
    sourceMessageId: row.source_message_id
      ? toMessageId(row.source_message_id)
      : undefined,
    metadata: row.metadata,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: toEpoch(row.last_accessed_at),
    pinned: row.pinned,
    expiresAt: toEpoch(row.expires_at),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    forgottenAt: toEpoch(row.forgotten_at),
  };
}

/** Epoch ms → a value `to_timestamp($n)` accepts. Postgres wants seconds. */
export function toTimestampParam(epochMs: number | undefined): number | null {
  return epochMs === undefined ? null : epochMs / 1000;
}

export function toEpoch(value: Date | null): number | undefined {
  return value === null ? undefined : value.getTime();
}

/** int8 arrives as a string; int4 as a number. Accept either, return a number. */
export function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export type { ConversationId, MemoryId, MessageId };
