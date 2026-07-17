/**
 * What a reasoner is given.
 *
 * Everything is injected; a reasoner reads no ambient state and no `process.env`,
 * per the kernel's rule that configuration is injected, never discovered
 * (RFC-0001 §3). The same shape as `PlanContext` (RFC-0003 §5.1), for the same
 * reason and on purpose — a strategy port and its context are one idea, learned
 * once.
 *
 * ## What is deliberately absent
 *
 * There is no `runtime`, no `registry`, and no `MemoryService`. Those are not
 * oversights; each is a thing a reasoner could use to act, and a reasoner must
 * only decide.
 *
 * - No registry, so a reasoner cannot invoke another agent. It says
 *   `{ kind: 'delegate' }` and the session looks the agent up.
 * - No `MemoryService`, so a reasoner cannot write a memory. It gets
 *   {@link MemoryAdapter}, which can only read.
 * - No `Runtime`, so a reasoner cannot start a mission.
 *
 * The `executor` is the one that looks like an exception and is not: it is how a
 * reasoner learns *what exists* ({@link AgentExecutor.available}). It also has
 * `execute`, and a reasoner calling it directly would defeat the whole design —
 * so it is not offered here at all. `ctx.capabilities` is the read-only half,
 * already selected by the agent's {@link ToolSelectionStrategy}, and the session
 * keeps the executor to itself. See RFC-0005 §5.2.
 */

import type { Clock, Logger } from '@hermes/kernel';
import type { AvailableCapability } from './ports/agent-executor.js';
import type { MemoryAdapter } from './ports/memory-adapter.js';
import type { PlannerAdapter } from './ports/planner-adapter.js';
import type { SessionId, SessionTurn, Transcript } from './model.js';

export interface AgentContext {
  readonly sessionId: SessionId;
  /** 1 on the first decision of the session. */
  readonly turn: number;
  /**
   * What this agent may ask for, already selected.
   *
   * Read-only, and the *only* thing a reasoner learns about capabilities. It has
   * been through the agent's `ToolSelectionStrategy`, so a reasoner sees what it
   * is meant to see and cannot widen its own reach by asking for more.
   */
  readonly capabilities: readonly AvailableCapability[];
  /**
   * What has happened so far, oldest first.
   *
   * Includes this session's earlier decisions and every observation. It is how a
   * reasoner sees the tool results from its own previous turn — a reasoner is
   * stateless between turns and this is its memory of the last one.
   */
  readonly history: readonly SessionTurn[];
  /**
   * The conversation in model terms.
   *
   * Built once per turn by the session, so a chain of reasoners agrees on what
   * was said rather than each rebuilding it from `history` and disagreeing.
   * A rule-based reasoner ignores it, which costs nothing.
   */
  readonly transcript: Transcript;
  /** Read-only memory. There is no write side; see {@link MemoryAdapter}. */
  readonly memory?: MemoryAdapter;
  /**
   * Planning, for a reasoner that must plan in order to decide.
   *
   * Optional, and absent unless a host wired it. A reasoner that needs it and did
   * not get it should abstain rather than guess. The ordinary way to ask for a
   * plan is a `PlanDecision` — see {@link PlannerAdapter}.
   */
  readonly planner?: PlannerAdapter;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Aborts when the caller gives up.
   *
   * Honouring it is not optional for anything that awaits — a model call is the
   * slowest thing in the system, and a reasoner that ignores its signal holds a
   * session, and behind it a kernel concurrency slot, long after the caller has
   * gone. Same cooperative contract as everywhere else (RFC-0001 §11.1).
   */
  readonly signal: AbortSignal | undefined;
}
