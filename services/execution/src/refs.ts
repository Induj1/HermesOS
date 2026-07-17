/**
 * Step references — how a step's input names an earlier step's output.
 *
 * ## This shape is not invented here
 *
 * RFC-0001 §11.4 states the constraint and then names the fix:
 *
 * > `dependsOn` is an ordering constraint, not a data flow. A task's `input` is
 * > static, fixed in the spec... If this must change, the least-bad shape is
 * > probably an explicit, kernel-opaque reference — `input: { $from: 'a' }`
 * > resolved by the runtime at dispatch — because it stays plain data and keeps
 * > the mission serialisable. It would still need a real design for
 * > partial/multiple dependencies. New RFC.
 *
 * This is that shape, that new RFC (RFC-0004), and that real design. The one
 * change: it is resolved **above** the kernel rather than inside it, by the
 * engine's step envelope at dispatch. The kernel stays frozen and never learns
 * that a payload means anything.
 *
 * ## Why a reference rather than a function
 *
 * A mapping function would be more expressive and is rejected for one reason: a
 * function is not data. A plan carrying `(prev) => prev.items[0]` cannot be
 * serialised, so it cannot be checkpointed, cannot be stored, cannot be shown to
 * a human for approval, and cannot be produced by a model that emits JSON.
 * Every one of those is a thing this system does. `{ $from: 'a', path: 'items.0' }`
 * survives all of them.
 *
 * The cost is real and worth naming: `path` is a lookup, not a transform. There
 * is no way to express "the sum of a's results" in a plan. That work belongs in
 * a step — a capability that takes the values and sums them — which keeps the
 * transform testable, named, and visible to the scheduler, rather than hidden in
 * a plan's punctuation.
 */

import { InvalidReferenceError } from './errors.js';

/**
 * A reference to an earlier step's result.
 *
 * `$from` names the step. `path` optionally reaches inside its result with
 * dot-separated keys, where a numeric segment indexes an array
 * (`'items.0.title'`). Absent `path`, the whole result is substituted.
 *
 * `$from` is spelled with a `$` for the same reason MongoDB and JSON Schema do:
 * it marks the key as belonging to the *format* rather than to the payload, and
 * an object literally containing a user key called `$from` is vanishingly rarer
 * than one containing `from`.
 */
export interface StepRef {
  readonly $from: string;
  readonly path?: string;
}

/**
 * What a reference is resolved against: step name to result.
 *
 * An interface rather than the concrete `ExecutionContext` so that resolution is
 * a pure function of a lookup. It is the reason every test in `refs.test.ts` is
 * a plain object rather than a running engine.
 */
export interface ResultLookup {
  has(step: string): boolean;
  get(step: string): unknown;
}

/**
 * Is this value a step reference?
 *
 * Narrow on purpose: `$from` must be a string, and `path` must be a string when
 * present. An object with a non-string `$from` is *not* treated as a reference
 * and is left alone — because the alternative is guessing at the author's intent
 * and silently substituting the wrong thing. A malformed reference is caught by
 * {@link validateRefs} at compile time, where the error can name the step.
 */
export function isStepRef(value: unknown): value is StepRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['$from'] !== 'string') return false;
  return candidate['path'] === undefined || typeof candidate['path'] === 'string';
}

/**
 * Does this value contain a reference anywhere inside it?
 *
 * Used to tell a step that needs resolution from one whose input is already
 * plain data, so the common case pays nothing.
 */
export function containsRef(value: unknown): boolean {
  if (isStepRef(value)) return true;
  if (Array.isArray(value)) return value.some(containsRef);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsRef);
  }
  return false;
}

/** Every step named by a reference inside a value, deduplicated. */
export function referencedSteps(value: unknown): readonly string[] {
  const found = new Set<string>();
  collect(value, found);
  return [...found];
}

function collect(value: unknown, into: Set<string>): void {
  if (isStepRef(value)) {
    into.add(value.$from);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>))
      collect(item, into);
  }
}

/**
 * Replace every reference in `input` with the value it names.
 *
 * Walks the whole structure, so a reference nested in an array inside an object
 * resolves like a top-level one — a model writing a plan will nest, and a
 * resolver that only looked at top-level keys would fail in a way that looks
 * like the model's fault.
 *
 * Returns a new value; `input` is never mutated. That matters more than it
 * looks: the same plan step is resolved again on every retry and on every
 * resume, so resolution has to be repeatable rather than destructive.
 *
 * @throws {InvalidReferenceError} when a referenced step has no result — which
 *   means it has not run, or ran and failed. Throwing is right: the alternative
 *   is substituting `undefined` and letting a capability act on a value that was
 *   never produced.
 */
export function resolveRefs(input: unknown, results: ResultLookup): unknown {
  if (isStepRef(input)) return resolveOne(input, results);

  if (Array.isArray(input)) return input.map((item) => resolveRefs(item, results));

  if (input !== null && typeof input === 'object') {
    // Rebuilt key by key rather than spread-and-overwrite so that a nested
    // reference deep in an untouched branch is still resolved.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = resolveRefs(value, results);
    }
    return out;
  }

  return input;
}

function resolveOne(ref: StepRef, results: ResultLookup): unknown {
  if (!results.has(ref.$from)) {
    throw new InvalidReferenceError(
      ref.$from,
      'it has no result — it has not run, or it ran and did not succeed',
    );
  }

  const value = results.get(ref.$from);
  if (ref.path === undefined) return value;
  return readPath(value, ref.path, ref.$from);
}

/**
 * Read a dot-separated path out of a value.
 *
 * A missing key throws rather than yielding `undefined`. The asymmetry with
 * plain JavaScript is deliberate: `a.b.c` quietly evaluating to `undefined` is
 * the single most common way a data-flow bug reaches production wearing a
 * disguise. Here the step that produced the value is named in the error, so the
 * fix is a plan edit rather than an afternoon.
 */
function readPath(value: unknown, path: string, step: string): unknown {
  const segments = path.split('.');
  let current = value;

  for (const [index, segment] of segments.entries()) {
    const reached = segments.slice(0, index).join('.');
    const where =
      reached === '' ? `"${step}"'s result` : `"${step}"'s result at "${reached}"`;

    if (current === null || current === undefined) {
      throw new InvalidReferenceError(
        step,
        `${where} is ${String(current)}, so "${path}" cannot be read`,
      );
    }

    if (Array.isArray(current)) {
      const at = Number(segment);
      if (!Number.isInteger(at)) {
        throw new InvalidReferenceError(
          step,
          `${where} is an array, but "${segment}" is not an index`,
        );
      }
      if (at < 0 || at >= current.length) {
        throw new InvalidReferenceError(
          step,
          `${where} has ${String(current.length)} item(s), so index ${segment} is out of range`,
        );
      }
      current = current[at];
      continue;
    }

    if (typeof current !== 'object') {
      throw new InvalidReferenceError(
        step,
        `${where} is a ${typeof current}, so "${segment}" cannot be read from it`,
      );
    }

    const record = current as Record<string, unknown>;
    // `in` rather than a truthiness check: a step legitimately returning
    // `{ found: false }` or `{ value: null }` must resolve to that value, not be
    // reported as missing.
    if (!(segment in record)) {
      throw new InvalidReferenceError(step, `${where} has no key "${segment}"`);
    }
    current = record[segment];
  }

  return current;
}

/**
 * Check every reference in a plan before anything runs.
 *
 * Two rules, and the second is the one that earns this function's existence.
 *
 * 1. **A reference must name a step in the plan.** A typo otherwise surfaces at
 *    dispatch, after the upstream half of the plan has already had its effects —
 *    which is exactly the kernel gap the planner exists to close (RFC-0003 §4),
 *    reappearing one level up in a different disguise. It is closed the same way:
 *    before anything runs.
 *
 * 2. **A reference must name a *declared dependency*.** This is the subtle one.
 *    `dependsOn` is what orders the graph; a reference is what reads a result.
 *    If step `b` references `a` without depending on it, the kernel is free to
 *    run them concurrently, and `b` resolves against a result that does not exist
 *    yet. It would fail — *usually*. Under load, or with a fast `a`, it would
 *    pass. A race that passes in tests and fails in production is the worst
 *    failure this design could have, so the two are required to agree, and
 *    disagreement is a compile-time error rather than a coin toss.
 *
 * Rejected: **inferring `dependsOn` from references.** It reads as a kindness and
 * is a trap. The plan would then have two sources of truth for its own shape, and
 * the planner's validator — which checks the graph for cycles and depth — would
 * be checking a graph that is not the one that runs. Worse, a cycle introduced
 * purely by references would be created *after* the only thing that looks for
 * cycles had already approved the plan. Requiring the author to say what they
 * mean keeps one graph, validated once.
 *
 * @param steps The plan's steps, in any order.
 * @throws {InvalidReferenceError} on the first problem, naming the step and why.
 */
export function validateRefs(
  steps: readonly {
    readonly name: string;
    readonly input?: unknown;
    readonly dependsOn?: readonly string[];
  }[],
): void {
  const known = new Set(steps.map((step) => step.name));

  for (const step of steps) {
    const deps = new Set(step.dependsOn ?? []);

    for (const target of referencedSteps(step.input)) {
      if (target === step.name) {
        throw new InvalidReferenceError(
          target,
          `step "${step.name}" references its own result`,
        );
      }
      if (!known.has(target)) {
        throw new InvalidReferenceError(
          target,
          `step "${step.name}" references it, but no such step is in the plan`,
        );
      }
      if (!deps.has(target)) {
        throw new InvalidReferenceError(
          target,
          `step "${step.name}" references it but does not declare it in dependsOn, ` +
            `so the two could run concurrently and the reference would resolve against ` +
            `a result that does not exist yet`,
        );
      }
    }
  }
}
