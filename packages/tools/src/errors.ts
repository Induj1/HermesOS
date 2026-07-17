/**
 * Every error the tool framework throws on purpose.
 *
 * Same contract as every layer below: a stable machine-readable `code` that
 * callers branch on, so message wording stays free to change (RFC-0001 §5). And
 * this hierarchy extends no other package's — a tool error that were
 * `instanceof KernelError` would claim the kernel threw it.
 *
 * ## These messages have a second audience
 *
 * Everywhere else in Hermes an error message is for a human reading a log. Here
 * it is often for a **model**, reading the failed observation of a tool it just
 * asked for, deciding what to send next (RFC-0005 §5.4). That changes what a good
 * message is: it must say which field, what was wrong with it, and what would
 * have been right — because the model's next turn is a rewrite of the argument
 * this one rejected, and a message like "invalid input" gives it nothing to
 * rewrite toward.
 */

export type ToolErrorCode =
  | 'SCHEMA_INVALID'
  | 'INPUT_INVALID'
  | 'OUTPUT_INVALID'
  | 'PERMISSION_DENIED'
  | 'TOOL_NOT_FOUND'
  | 'INVALID_DEFINITION';

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * A value did not match its schema.
 *
 * Carries `path` and `detail` separately rather than one formatted string,
 * because a nested schema does not know where it sits. `string()` throws
 * "must be a string" knowing only itself; `object()` catches it and calls
 * {@link at} to prefix the field name, and `array()` prefixes the index. By the
 * time it surfaces it reads `"files.0.path" must be a string`, and no schema had
 * to be told its own address.
 */
export class SchemaError extends ToolError {
  /** Dot-separated path from the root. `''` means the root value itself. */
  readonly path: string;
  /** What was wrong, as a clause completing "«path» …". */
  readonly detail: string;

  constructor(path: string, detail: string) {
    super('SCHEMA_INVALID', `${describePath(path)} ${detail}`);
    this.path = path;
    this.detail = detail;
  }

  /**
   * The same problem, one level further in.
   *
   * Returns a new error rather than mutating: an error is a value, and the parse
   * that caught this one may be inside an `array().map` that will catch several.
   */
  at(prefix: string): SchemaError {
    return new SchemaError(
      prefix === '' ? this.path : join(prefix, this.path),
      this.detail,
    );
  }
}

/**
 * A tool was called with input its schema rejected.
 *
 * Distinct from {@link SchemaError} — which is about *a value* — because this is
 * about *a call*, and it names the tool. A model reading "«path» must be a
 * string" has no idea which of the three tools it just asked for is complaining.
 */
export class InputInvalidError extends ToolError {
  readonly tool: string;
  readonly issue: string;

  constructor(tool: string, issue: string, options?: ErrorOptions) {
    super('INPUT_INVALID', `${tool} was called with invalid input: ${issue}`, options);
    this.tool = tool;
    this.issue = issue;
  }
}

/**
 * A tool returned something its own schema rejected.
 *
 * **A bug in the tool, not in the caller**, and the message says so — because a
 * model reading this must not try to fix it by rewriting its arguments, which is
 * the only thing it can do and the one thing that cannot help. Naming the fault
 * is what stops a model burning its whole turn budget on an input that was fine.
 */
export class OutputInvalidError extends ToolError {
  readonly tool: string;
  readonly issue: string;

  constructor(tool: string, issue: string, options?: ErrorOptions) {
    super(
      'OUTPUT_INVALID',
      `${tool} returned a value that does not match its own output schema: ${issue}. ` +
        `This is a fault in the tool, not in how it was called`,
      options,
    );
    this.tool = tool;
    this.issue = issue;
  }
}

/**
 * A tool was called without the permission it declares.
 *
 * Carries the permission rather than only saying no, because the two audiences
 * need different things from it: an operator needs to know which grant to add,
 * and a model needs to know this is not a rewrite-your-arguments problem.
 */
export class PermissionDeniedError extends ToolError {
  readonly tool: string;
  readonly permission: string;

  constructor(tool: string, permission: string, reason?: string) {
    super(
      'PERMISSION_DENIED',
      `${tool} requires the "${permission}" permission, which was not granted` +
        (reason === undefined ? '' : `: ${reason}`) +
        `. Retrying with different arguments will not help`,
    );
    this.tool = tool;
    this.permission = permission;
  }
}

/** No tool with this name is registered. */
export class ToolNotFoundError extends ToolError {
  readonly tool: string;

  constructor(tool: string, known: readonly string[]) {
    super(
      'TOOL_NOT_FOUND',
      known.length === 0
        ? `No tool named "${tool}" is registered, and no tools are registered at all.`
        : `No tool named "${tool}" is registered. Known tools: ${known.join(', ')}.`,
    );
    this.tool = tool;
  }
}

/**
 * A tool declaration is malformed.
 *
 * Thrown at `defineTool`, which is module-load time — so a bad declaration is a
 * crash on boot rather than a failure on the first call. Same reasoning as the
 * planner rejecting an empty strategy chain at construction (RFC-0003 §5.2): a
 * tool that can never work is a wiring mistake, and it should fail where the
 * wiring is.
 */
export class InvalidDefinitionError extends ToolError {
  readonly issues: readonly string[];

  constructor(tool: string, issues: readonly string[]) {
    super(
      'INVALID_DEFINITION',
      `Tool "${tool}" is not a valid definition: ${issues.join('; ')}`,
    );
    this.issues = issues;
  }
}

/**
 * Coerce anything thrown into an `Error`.
 *
 * Each layer keeps its own rather than importing another's: every catch block
 * here would otherwise depend on a package to handle an error that package did
 * not throw — a coupling with no payoff.
 */
export function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (typeof thrown === 'string') return new Error(thrown);
  return new Error(`Non-Error thrown: ${String(thrown)}`, { cause: thrown });
}

function describePath(path: string): string {
  return path === '' ? 'input' : `"${path}"`;
}

function join(prefix: string, path: string): string {
  return path === '' ? prefix : `${prefix}.${path}`;
}
