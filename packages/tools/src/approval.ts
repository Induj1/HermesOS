/**
 * Approval — holding an effect until a person says yes.
 *
 * ## What this is not
 *
 * Three questions look like one "may this happen?" check and are not, and fusing
 * them produces a gate that answers none of them well:
 *
 * | | asks | answered by | known at |
 * | --- | --- | --- | --- |
 * | permissions | *may this tool do this kind of thing at all?* | a `Set` | wiring time |
 * | authorisation | *may this principal ask for it?* | a policy engine | request time |
 * | approval | *should this exact call happen, now?* | **a person** | the moment of the call |
 *
 * Only the third can look at the arguments. `fs:write` is granted or it is not,
 * and it says the same thing about writing a scratch file and about writing
 * `/etc/passwd`; a policy engine can know the caller is an admin and still not
 * know that this particular path is the production database. Approval is the
 * layer that gets to read `input` and decide about *this* call, which is also why
 * it is the only one of the three that cannot be answered in advance.
 *
 * ## Why this is a tool middleware
 *
 * Because `middleware.ts` already made the argument: a tool middleware guards the
 * *effect*, so it also catches the call a plan made directly, a host made in a
 * script, or another tool made in a composition. An approval gate that lived in
 * the agent loop would guard what an agent *intends* and miss every one of those,
 * which for an irreversible effect is the wrong half to guard.
 *
 * ## Why the host supplies the approver
 *
 * Same reason a host supplies the `PermissionSet`: *how* a person is asked is not
 * knowable to the tool. The same `deploy` tool is approved by a CLI prompt on a
 * laptop, a button in a web console, and a WhatsApp reply in production. A tool
 * that reached for a prompt would work in exactly one of those and hang in the
 * other two.
 */

import { CancellationError } from '@hermes/kernel';
import type { ToolContext } from '@hermes/kernel';
import { ApprovalDeniedError } from './errors.js';
import { withMiddleware } from './middleware.js';
import { assertPermitted, type PermissionSet } from './permissions.js';
import type { AnyHermesTool, HermesTool } from './tool.js';

/**
 * How long to wait for a person, when the host does not say.
 *
 * Five minutes, and the interesting choice is that there *is* a default rather
 * than what it is. "Wait forever" is the obvious reading of human-in-the-loop and
 * it is a hang: a mission blocks on a notification nobody saw, holding its
 * checkpoint and its budget, and the failure presents as the agent being slow
 * rather than as anything asking for attention. A gate that expires is a gate an
 * operator finds out about.
 *
 * Hosts with a real out-of-band channel — a queue an operator works through hours
 * later — should raise it deliberately. That is a different product with
 * different expectations, and it should have to say so.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/**
 * What a person is shown before deciding.
 *
 * Deliberately flat and serialisable. An approver frequently does not run in this
 * process — it posts to a queue, sends a message, writes a row — and a request
 * carrying the live `ToolContext` would carry a `Logger`, a `Clock` and an
 * `AbortSignal` across that boundary, none of which survive it. What crosses is
 * what a person needs to read, plus what the decision must be recorded against.
 */
export interface ApprovalRequest {
  /** The tool about to run. */
  readonly tool: string;
  /**
   * Why this tool needs a person, as the tool itself declared it.
   *
   * Shown verbatim to whoever decides, which is what makes it worth a sentence
   * rather than a category. "Deletes objects from the production bucket" tells an
   * operator what they are being asked; "destructive" tells them only that they
   * are being asked something.
   */
  readonly reason: string;
  /**
   * The exact arguments the tool was called with.
   *
   * The whole point of approving at this layer rather than at wiring time, and
   * the reason it is `unknown`: an approver renders it, and rendering is the only
   * thing that can be done with a payload whose shape belongs to the tool.
   *
   * A host that puts secrets in tool arguments will show them to whoever
   * approves. That is a property of the arguments and this gate cannot fix it — a
   * middleware ordered before this one can, by rewriting `input`, which is why
   * `ToolMiddleware` passes input along instead of closing over it.
   */
  readonly input: unknown;
  readonly missionId: ToolContext['missionId'];
  readonly taskId: ToolContext['taskId'];
  readonly taskName: string;
  /**
   * 1 on the first try, as the kernel counts it.
   *
   * Carried because a retry is a *new* request for a *new* effect, and an
   * approver that wants to notice "this is the third time it has asked to
   * redeploy" needs to be told. Nothing here interprets it.
   */
  readonly attempt: number;
}

/**
 * A person's answer.
 *
 * A discriminated union rather than a boolean beside an optional string, so a
 * refusal cannot be constructed without somewhere to put the reason — and the
 * reason is the half that matters. An agent told only "denied" will retry the
 * identical call; one told "denied: staging only until the incident is closed"
 * has something to replan around.
 */
export type ApprovalDecision =
  { readonly approved: true } | { readonly approved: false; readonly reason?: string };

/**
 * Ask a person, however this host asks people.
 *
 * Returning a decision means "a person answered". **Throwing means the gate could
 * not be operated** — the queue was unreachable, the console was down — and those
 * are not the same event: one is a refusal to record, the other is an outage to
 * fix. Both stop the call, and {@link withApproval} keeps them distinguishable in
 * what it throws.
 */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ApprovalOptions {
  /** Overrides {@link DEFAULT_APPROVAL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Approve everything, immediately.
 *
 * For tests, and for a developer running locally who does not want to answer a
 * prompt on every call. It defeats the gate completely, which is why it is named
 * for what it does rather than something like `defaultApprover` — a host wiring
 * this into production should have to read the word `auto` first.
 */
export const autoApprove: Approver = () => Promise.resolve({ approved: true });

/**
 * Refuse everything.
 *
 * The honest wiring for a context that has no way to ask anyone — a scheduled run
 * at 3am, a sandbox with no operator. Better than leaving the tool ungated, which
 * silently turns "needs a person" into "needs nobody", and better than
 * {@link autoApprove}, which does the same thing while reading as a decision.
 */
export const denyAll: Approver = () =>
  Promise.resolve({
    approved: false,
    reason: 'this host has no way to ask anyone for approval',
  });

/**
 * Hold a tool until an approver says yes.
 *
 * A no-op unless the tool declares `requiresApproval`, so this can be applied to
 * a whole toolset without auditing it first — the tool decides whether it needs a
 * person, and the host decides who that person is. That split is the same one
 * `withPermissions` makes and for the same reason: the tool knows what it does,
 * and only the host knows the context it does it in.
 *
 * ```ts
 * const gated = withApproval(deployTool, askOperatorOnWhatsApp);
 * ```
 *
 * ## It fails closed, on every path
 *
 * A timeout denies. An approver that throws denies. `middleware.ts` says a guard
 * that fails open is the worst thing a guard can be, and this is the guard where
 * that is most true: the tools reaching it are the ones whose effects cannot be
 * taken back, so the cost of wrongly denying is a retry and the cost of wrongly
 * allowing is a production incident.
 *
 * The one exception is cancellation. If the mission is aborted while a person is
 * deciding, the {@link CancellationError} propagates unchanged rather than being
 * flattened into a denial — nobody denied it, and a recovery policy reading the
 * failure needs the difference between "a human said no" (do not retry) and "we
 * were cancelled" (retry when resumed).
 *
 * ## The decision is not remembered
 *
 * Approving `deploy` once does not approve the next `deploy`. There is no cache,
 * and adding one would quietly change what an operator agreed to: they approved
 * an *effect*, described by the arguments in front of them, not a standing grant
 * on a tool name. A host that genuinely wants "yes to all of these" builds it in
 * the approver, where the scope of the yes is explicit and recorded.
 */
export function withApproval<TInput, TOutput>(
  tool: HermesTool<TInput, TOutput>,
  approver: Approver,
  options: ApprovalOptions = {},
): HermesTool<TInput, TOutput> {
  const reason = tool.requiresApproval;
  if (reason === undefined || reason.trim() === '') return tool;

  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  return withMiddleware(tool, [
    async (input, ctx, next) => {
      const decision = await decide(
        approver,
        {
          tool: tool.name,
          reason,
          input,
          missionId: ctx.missionId,
          taskId: ctx.taskId,
          taskName: ctx.taskName,
          attempt: ctx.attempt,
        },
        ctx,
        timeoutMs,
      );

      if (!decision.approved) {
        throw new ApprovalDeniedError(tool.name, reason, decision.reason);
      }

      // Logged after the yes and before the effect, so the record exists even if
      // the tool then throws. An approval whose only trace is a successful result
      // is missing exactly the cases an audit is opened to look at.
      ctx.logger.info('tool call approved', {
        tool: tool.name,
        missionId: ctx.missionId,
        taskId: ctx.taskId,
        attempt: ctx.attempt,
      });

      return await next(input, ctx);
    },
  ]);
}

/**
 * Every tool in a set, behind one approver.
 *
 * Sugar with the same argument as `withPermissionsAll`: the approver is decided
 * once, for a whole toolset, at the composition root. Gating tools one at a time
 * is how one gets forgotten — and the one that gets forgotten is the one nobody
 * thought needed it.
 */
export function withApprovalAll(
  tools: readonly AnyHermesTool[],
  approver: Approver,
  options: ApprovalOptions = {},
): readonly AnyHermesTool[] {
  return tools.map((tool) => withApproval(tool, approver, options));
}

/**
 * Both guards, in the order that does not waste a person's time.
 *
 * Permissions **outside** approval, which is the ordering hosts get backwards.
 * `withMiddleware` makes the first layer outermost, so this checks the grant
 * before it asks anyone — and a tool that was never permitted is a wiring fact
 * that should fail instantly, not after an operator has read a notification,
 * walked to their laptop, and approved a call that was going to be refused
 * anyway.
 *
 * The reverse order is not merely slower. It teaches operators that approving is
 * sometimes meaningless, which is the fastest way to get a real one waved
 * through.
 */
export function guard<TInput, TOutput>(
  tool: HermesTool<TInput, TOutput>,
  granted: PermissionSet,
  approver: Approver,
  options: ApprovalOptions = {},
): HermesTool<TInput, TOutput> {
  const gated = withApproval(tool, approver, options);
  if (tool.permissions === undefined || tool.permissions.length === 0) return gated;

  return withMiddleware(gated, [
    async (input, ctx, next) => {
      assertPermitted(tool.name, tool.permissions, granted);
      return await next(input, ctx);
    },
  ]);
}

/** "The clock won" — a value no approver can return, so it cannot be mistaken for one. */
const EXPIRED = Symbol('approval-expired');

/**
 * Race the person against the clock, and clean up whichever loses.
 *
 * The `AbortController` is the whole reason this is a function rather than three
 * lines inline. `Promise.race` settles but does not cancel, so an approver that
 * answers in two seconds would otherwise leave a five-minute timer alive — and
 * `systemClock.sleep` uses a plain `setTimeout`, which keeps the process from
 * exiting. A short-lived CLI would appear to hang after doing its work correctly.
 */
async function decide(
  approver: Approver,
  request: ApprovalRequest,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  const gate = new AbortController();
  const forward = (): void => {
    gate.abort();
  };
  ctx.signal.addEventListener('abort', forward, { once: true });

  try {
    const outcome = await Promise.race<ApprovalDecision | typeof EXPIRED>([
      // An approver that throws is an outage, not a refusal — but it must still
      // stop the call. It becomes a denial carrying its own cause, so the effect
      // does not happen and the reason survives into the error message.
      approver(request).catch((thrown: unknown) => ({
        approved: false as const,
        reason: `the approver could not be reached: ${describe(thrown)}`,
      })),
      ctx.clock.sleep(timeoutMs, gate.signal).then(
        () => EXPIRED,
        // Rejects when `gate` aborts, which happens on cancellation *and* in the
        // `finally` below when the approver won. Swallowed here and re-read from
        // the signal afterwards, because those two are identical from inside the
        // sleep and mean opposite things outside it.
        () => EXPIRED,
      ),
    ]);

    if (outcome === EXPIRED) {
      if (ctx.signal.aborted) {
        throw new CancellationError(
          `Mission cancelled while awaiting approval for ${request.tool}`,
        );
      }
      return {
        approved: false,
        reason: `no decision within ${String(timeoutMs)}ms`,
      };
    }

    return outcome;
  } finally {
    ctx.signal.removeEventListener('abort', forward);
    // Cancels the losing timer. Unconditional: if the sleep already settled this
    // is a no-op, and if it did not, this is the line that lets the process exit.
    gate.abort();
  }
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
