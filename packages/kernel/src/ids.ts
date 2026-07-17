/**
 * Identifiers.
 *
 * Mission and task ids are branded strings. The brand is erased at runtime —
 * they are ordinary strings — but it stops a `TaskId` from being passed where a
 * `MissionId` belongs, which is the kind of mistake that is otherwise invisible
 * until something looks up the wrong map at 3am.
 */

declare const brand: unique symbol;

/** Attach a compile-time-only tag to a primitive. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type MissionId = Brand<string, 'MissionId'>;
export type TaskId = Brand<string, 'TaskId'>;

/**
 * Produces a fresh id for a given prefix.
 *
 * Injected rather than imported so tests can make ids deterministic; nothing in
 * the kernel derives meaning from an id's shape.
 */
export type IdGenerator = (prefix: string) => string;

/** The production generator: prefixed UUIDv4. */
export const randomIds: IdGenerator = (prefix) => `${prefix}_${crypto.randomUUID()}`;

/** A counting generator (`mission_1`, `task_1`, ...) for tests and fixtures. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next)}`;
  };
}

export function toMissionId(raw: string): MissionId {
  return raw as MissionId;
}

export function toTaskId(raw: string): TaskId {
  return raw as TaskId;
}
