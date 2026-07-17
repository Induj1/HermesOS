/**
 * Tool permissions — declaring what a tool needs, and refusing it what it does not have.
 *
 * ## What this is not
 *
 * It is **not** authorisation. It does not know who is asking, has no concept of a
 * user, a role, or a session, and cannot answer "may Ada run this?". That is the
 * Authorization subsystem's job and it is not built yet.
 *
 * This is the layer underneath: a tool *declares* what it needs (`fs:write`,
 * `net:http`), and a host *grants* a set. The check is a set membership test with
 * no policy in it. When an authorisation layer arrives it decides the grant —
 * per-user, per-agent, per-mission — and hands it here, and nothing in this file
 * changes.
 *
 * Keeping the two apart matters because they fail differently. A missing grant is
 * a *configuration* fact known at wiring time; a denied user is a *runtime*
 * decision about a principal. Fusing them would make every tool call wait on a
 * policy engine to answer a question a `Set` already knows.
 *
 * ## Why a string and not an enum
 *
 * Tools arrive from plugins, and a plugin's permissions are not knowable to this
 * package. A closed enum would mean every new tool domain needed a change *here*,
 * which is the coupling plugins exist to avoid. `domain:action` is a convention
 * the framework helps with and does not enforce.
 */

import { PermissionDeniedError } from './errors.js';

/**
 * Something a tool needs permission to do.
 *
 * By convention `domain:action` — `fs:read`, `fs:write`, `net:http`, `shell:exec`,
 * `git:push`. The convention is what makes {@link PermissionSet} able to grant a
 * whole domain with `fs:*`.
 */
export type Permission = string;

/** A permission that grants a whole domain. `fs:*` covers `fs:read` and `fs:write`. */
const WILDCARD = '*';

/**
 * What a host has granted.
 *
 * Immutable. A set that could be widened after construction would make "what is
 * this host allowed to do" a question with a different answer depending on when
 * you asked — and the answer would be decided by whichever plugin loaded last,
 * which is the race the kernel's registry exists to prevent.
 */
export class PermissionSet {
  readonly #granted: ReadonlySet<Permission>;

  constructor(granted: readonly Permission[] = []) {
    this.#granted = new Set(granted);
  }

  /** Everything, for a host that has decided it trusts its tools. */
  static all(): PermissionSet {
    return new PermissionSet([WILDCARD]);
  }

  /**
   * Nothing.
   *
   * The right default for an untrusted context, and a real one rather than a null
   * object: a tool with no declared permissions still runs under it, because a
   * tool that needs nothing is not asking for anything.
   */
  static none(): PermissionSet {
    return new PermissionSet([]);
  }

  /** Is this permission granted, directly or by a wildcard? */
  has(permission: Permission): boolean {
    if (this.#granted.has(WILDCARD)) return true;
    if (this.#granted.has(permission)) return true;

    // `fs:*` grants `fs:read`. Only one level: `*:read` is *not* supported, and
    // that is deliberate — "everything that reads" reads like a safe grant and is
    // not, because it spans every domain including ones installed later by a
    // plugin nobody reviewed. Domains are the axis a host reasons about.
    const colon = permission.indexOf(':');
    if (colon === -1) return false;
    return this.#granted.has(`${permission.slice(0, colon)}:${WILDCARD}`);
  }

  /** Every permission this tool declares that is not granted. Empty means allowed. */
  missing(required: readonly Permission[]): readonly Permission[] {
    return required.filter((permission) => !this.has(permission));
  }

  /** A new set with more granted. Returns a copy; this one is unchanged. */
  grant(...permissions: readonly Permission[]): PermissionSet {
    return new PermissionSet([...this.#granted, ...permissions]);
  }

  /** What was granted, sorted. For diagnostics and for an operator's log. */
  list(): readonly Permission[] {
    return [...this.#granted].sort();
  }

  get size(): number {
    return this.#granted.size;
  }
}

/**
 * Refuse a tool the permissions it declares and was not granted.
 *
 * Throws on the **first** missing permission rather than collecting them all,
 * which is the opposite of what this repository does everywhere else — the
 * planner, the kernel and the schema layer all report every issue at once because
 * an author fixing a spec wants the whole list.
 *
 * The audience is different here, and it decides it. This message is read by an
 * *operator* granting a permission and by a *model* that must learn not to retry.
 * Neither is served by a list: the operator grants one at a time and re-runs, and
 * the model needs "stop" rather than a menu. Naming one and stopping is the
 * clearer signal.
 */
export function assertPermitted(
  tool: string,
  required: readonly Permission[] | undefined,
  granted: PermissionSet,
): void {
  if (required === undefined || required.length === 0) return;

  const [first, ...rest] = granted.missing(required);
  if (first === undefined) return;

  throw new PermissionDeniedError(
    tool,
    first,
    rest.length > 0 ? `it also needs ${rest.join(', ')}` : undefined,
  );
}
