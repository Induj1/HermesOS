/**
 * The memory plugin: how this service attaches to a kernel.
 *
 * RFC-0001 §11.2 specifies the seam exactly — "a store is a plugin that
 * subscribes — most likely via `onAny` — and writes. Because `emit` awaits, such
 * a plugin gets real backpressure rather than silently lagging." This is that
 * plugin, and it uses `definePlugin`, `PluginContext`, and `ctx.bus.onAny` — all
 * public API. It reaches into nothing.
 *
 * It does two things:
 *
 *   1. **Persists missions.** Every event carrying a `MissionSnapshot` is
 *      projected into `mission`/`mission_task`, and every event at all is
 *      appended to `mission_event`.
 *   2. **Registers memory tools.** `memory.remember` and `memory.recall`, so an
 *      agent can use memory the same way it uses any other capability — through
 *      the kernel's registry, with no import of this package.
 */

import {
  defineTool,
  definePlugin,
  type EmittedEvent,
  type MissionId,
  type MissionSnapshot,
  type Plugin,
  type TaskId,
  type TaskSnapshot,
  type Tool,
} from '@hermes/kernel';
import { toError } from './errors.js';
import type { MemoryService } from './memory-service.js';
import { MEMORY_KINDS, type MemoryKind, type Subject } from './model.js';

export interface MemoryPluginOptions {
  readonly memory: MemoryService;
  /**
   * Project mission snapshots into `mission`/`mission_task`. Default true.
   */
  readonly persistMissions?: boolean;
  /**
   * Append every event to `mission_event`. Default true.
   *
   * This is one INSERT per event, on the emit path, and `emit` awaits its
   * listeners — so this genuinely costs the scheduler latency. That is the
   * backpressure RFC-0001 §5.7 designed for and not a bug, but it is why this is
   * a switch: a host running high-frequency missions may want the projection
   * without the full audit log.
   */
  readonly auditLog?: boolean;
  /**
   * Subject for memories written by the `memory.*` tools when a caller gives none.
   * Defaults to `'default'`.
   */
  readonly defaultSubject?: Subject;
}

/** Payloads that carry a mission snapshot. */
interface MissionEventPayload {
  readonly mission: MissionSnapshot;
}

interface TaskEventPayload {
  readonly task: TaskSnapshot;
}

export function memoryPlugin(options: MemoryPluginOptions): Plugin {
  const {
    memory,
    persistMissions = true,
    auditLog = true,
    defaultSubject = 'default',
  } = options;

  return definePlugin({
    name: 'memory',
    version: '0.0.0',

    setup(ctx) {
      const logger = ctx.logger;

      ctx.registerTool(rememberTool(memory, defaultSubject));
      ctx.registerTool(recallTool(memory, defaultSubject));

      if (persistMissions || auditLog) {
        const subscription = ctx.bus.onAny(async (event: EmittedEvent) => {
          try {
            await handleEvent(event);
          } catch (thrown) {
            // Never rethrow. The bus routes a listener's exception to
            // onListenerError and carries on (RFC-0001 §5.7) — but a store that
            // throws on every event would flood that channel and, more to the
            // point, a database being down must not stop missions from running.
            // Persistence is an observer of the system, not a participant in it.
            logger.error('Failed to persist kernel event', {
              type: event.type,
              error: toError(thrown).message,
            });
          }
        });

        // Reverse-order teardown: the kernel disposes plugins before whatever
        // they depended on, so unsubscribing here means no event arrives after
        // the pool this writes to might be closing.
        ctx.onDispose(() => {
          subscription.unsubscribe();
        });
      }

      async function handleEvent(event: EmittedEvent): Promise<void> {
        const missionId = missionIdOf(event);
        const taskId = taskIdOf(event);

        if (persistMissions) {
          const snapshot = missionSnapshotOf(event);
          if (snapshot) await memory.missions.save(snapshot);
        }

        if (auditLog) {
          await memory.missions.appendEvent(event.type, redact(event.payload), {
            ...(missionId === undefined ? {} : { missionId }),
            ...(taskId === undefined ? {} : { taskId }),
          });
        }
      }
    },
  });
}

/**
 * Reduce an event payload to something jsonb can hold.
 *
 * `task:failed` carries a live `Error`, and `JSON.stringify(new Error('boom'))`
 * is `'{}'`. Left alone, the audit log would faithfully record that every
 * failure had no cause. The mission projection handles this via `flattenError`;
 * this is the same problem one level up, for the raw payload.
 */
function redact(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value instanceof Error) {
      output[key] = { name: value.name, message: value.message, stack: value.stack };
    } else {
      output[key] = value;
    }
  }
  return output;
}

function missionSnapshotOf(event: EmittedEvent): MissionSnapshot | undefined {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  if (!('mission' in payload)) return undefined;
  return (payload as MissionEventPayload).mission;
}

/**
 * The mission an event belongs to.
 *
 * Structural, not a switch over event names. The kernel's catalogue grows
 * (events.ts is explicitly "the event catalogue — the observable surface"), and
 * a switch here would silently stop tagging new events — the audit rows would
 * still be written, just orphaned, which is the kind of gap nobody notices until
 * they need the log.
 */
function missionIdOf(event: EmittedEvent): MissionId | undefined {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') return undefined;

  if ('mission' in payload) return (payload as MissionEventPayload).mission.id;
  if ('task' in payload) return (payload as TaskEventPayload).task.missionId;
  // kernel:error carries missionId/taskId directly, and may carry neither.
  if ('missionId' in payload) {
    const raw = payload.missionId;
    return typeof raw === 'string' ? (raw as MissionId) : undefined;
  }
  return undefined;
}

function taskIdOf(event: EmittedEvent): TaskId | undefined {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') return undefined;

  if ('task' in payload) return (payload as TaskEventPayload).task.id;
  if ('taskId' in payload) {
    const raw = payload.taskId;
    return typeof raw === 'string' ? (raw as TaskId) : undefined;
  }
  return undefined;
}

// --- tools ----------------------------------------------------------------

interface RememberInput {
  readonly content: string;
  readonly kind?: MemoryKind;
  readonly subject?: Subject;
  readonly importance?: number;
  readonly pinned?: boolean;
}

interface RecallInput {
  readonly query: string;
  readonly subject?: Subject;
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
}

function rememberTool(
  memory: MemoryService,
  defaultSubject: Subject,
): Tool<RememberInput, { id: string; importance: number }> {
  return defineTool<RememberInput, { id: string; importance: number }>({
    name: 'memory.remember',
    description: 'Store something worth remembering about the current subject.',
    // The kernel's Validator is `{ parse(input: unknown): T }` — structurally a
    // Zod schema, without the kernel depending on Zod (kernel tool.ts §Validator).
    // Hand-written here rather than reaching for a schema library, because this
    // package would otherwise take a dependency to check four fields.
    //
    // This input may have come from a model, so it is parsed, not cast.
    input: {
      parse: (input: unknown): RememberInput => {
        if (input === null || typeof input !== 'object') {
          throw new TypeError('memory.remember expects an object');
        }
        const raw = input as Record<string, unknown>;
        const issues: string[] = [];

        if (typeof raw['content'] !== 'string' || raw['content'].trim() === '') {
          issues.push('content must be a non-empty string');
        }
        const kind = raw['kind'];
        if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) {
          issues.push(`kind must be one of: ${MEMORY_KINDS.join(', ')}`);
        }
        if (issues.length > 0) throw new TypeError(issues.join('; '));

        return {
          content: raw['content'] as string,
          ...(kind === undefined ? {} : { kind: kind as MemoryKind }),
          ...(typeof raw['subject'] === 'string' ? { subject: raw['subject'] } : {}),
          ...(typeof raw['importance'] === 'number'
            ? { importance: raw['importance'] }
            : {}),
          ...(typeof raw['pinned'] === 'boolean' ? { pinned: raw['pinned'] } : {}),
        };
      },
    },
    execute: async (input) => {
      const record = await memory.remember({
        subject: input.subject ?? defaultSubject,
        kind: input.kind ?? 'fact',
        content: input.content,
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      });
      return { id: record.id, importance: record.importance };
    },
  });
}

type RecallOutput = readonly {
  id: string;
  content: string;
  kind: MemoryKind;
  score: number;
}[];

function recallTool(
  memory: MemoryService,
  defaultSubject: Subject,
): Tool<RecallInput, RecallOutput> {
  return defineTool<RecallInput, RecallOutput>({
    name: 'memory.recall',
    description: 'Retrieve memories relevant to a query, best first.',
    input: {
      parse: (input: unknown): RecallInput => {
        if (input === null || typeof input !== 'object') {
          throw new TypeError('memory.recall expects an object');
        }
        const raw = input as Record<string, unknown>;
        if (typeof raw['query'] !== 'string' || raw['query'].trim() === '') {
          throw new TypeError('query must be a non-empty string');
        }
        return {
          query: raw['query'],
          ...(typeof raw['subject'] === 'string' ? { subject: raw['subject'] } : {}),
          ...(typeof raw['limit'] === 'number' ? { limit: raw['limit'] } : {}),
          // Unknown kinds are dropped rather than rejected. A model asking for a
          // kind that does not exist should get the memories it *can* have, not
          // a validation error it cannot act on.
          ...(Array.isArray(raw['kinds'])
            ? {
                kinds: raw['kinds'].filter((kind): kind is MemoryKind =>
                  MEMORY_KINDS.includes(kind as MemoryKind),
                ),
              }
            : {}),
        };
      },
    },
    execute: async (input) => {
      // A caller that named kinds and had every one of them dropped as unknown
      // has asked for something that cannot match. Passing the empty list down
      // would *widen* the request instead of narrowing it: the repository reads
      // an empty `kinds` as "unspecified" (`kinds.length > 0`), so the filter
      // would silently turn into no filter and return every kind there is.
      //
      // That is the dangerous direction. A host that uses `kinds` to keep an
      // agent away from a sensitive kind would find one unknown kind granting
      // access to all of them. Returning nothing is the honest reading of
      // "the memories it can have" — for a kind that does not exist, there are
      // none — and it fails closed.
      if (input.kinds?.length === 0) return [];

      const results = await memory.recall(
        input.subject ?? defaultSubject,
        input.query,
        {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        },
      );
      return results.map((result) => ({
        id: result.memory.id,
        content: result.memory.content,
        kind: result.memory.kind,
        score: result.score,
      }));
    },
  });
}
