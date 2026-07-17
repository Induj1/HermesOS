/**
 * The kernel's event catalogue — its observable surface, in one file.
 *
 * Every payload carries snapshots, never live objects. A subscriber cannot
 * mutate a task by holding an event, and an event stays true to the moment it
 * described even if the task moves on. That is what makes the stream safe to
 * persist, replay, or ship over a wire.
 */

import type { MissionSnapshot } from './mission.js';
import type { MissionId, TaskId } from './ids.js';
import type { TaskSnapshot } from './task.js';

export interface KernelEventMap {
  'runtime:starting': { readonly at: number };
  'runtime:started': { readonly at: number };
  'runtime:stopping': { readonly at: number; readonly mode: 'drain' | 'cancel' };
  'runtime:stopped': { readonly at: number };

  'plugin:registered': { readonly name: string; readonly version: string | undefined };
  'plugin:disposed': { readonly name: string };

  'mission:submitted': { readonly mission: MissionSnapshot };
  'mission:started': { readonly mission: MissionSnapshot };
  'mission:succeeded': { readonly mission: MissionSnapshot };
  'mission:failed': { readonly mission: MissionSnapshot };
  'mission:cancelled': { readonly mission: MissionSnapshot; readonly reason: string };

  'task:ready': { readonly task: TaskSnapshot };
  'task:started': { readonly task: TaskSnapshot };
  'task:succeeded': { readonly task: TaskSnapshot; readonly durationMs: number };
  'task:failed': { readonly task: TaskSnapshot; readonly error: Error };
  'task:retrying': {
    readonly task: TaskSnapshot;
    readonly error: Error;
    readonly delayMs: number;
  };
  'task:cancelled': { readonly task: TaskSnapshot; readonly reason: string };
  'task:skipped': { readonly task: TaskSnapshot; readonly reason: string };

  /** No work in flight and nothing runnable. The signal a drain waits on. */
  'scheduler:idle': { readonly at: number };
  /**
   * Something threw where nothing should have — a listener, a dispose. Reported
   * rather than propagated, because the alternative is a subscriber's bug taking
   * down the scheduler.
   */
  'kernel:error': {
    readonly error: Error;
    readonly context: string;
    readonly missionId: MissionId | undefined;
    readonly taskId: TaskId | undefined;
  };
}

export type KernelEventName = keyof KernelEventMap;
