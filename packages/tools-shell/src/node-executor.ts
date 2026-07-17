/**
 * The real shell executor, backed by `node:child_process`.
 *
 * The only file in the package that spawns a process, and it uses `spawn` with an
 * argv array and **`shell: false`** — the one line that makes command injection
 * unrepresentable (see `executor.ts`). Never `exec`, which runs a shell; never a
 * string; never `shell: true`.
 *
 * Everything else here is a bound around a process the executor holds and nothing
 * else can: the timeout, the output cap, and the signal all end in a kill, and a
 * kill is only possible from where the handle is.
 */

import { spawn } from 'node:child_process';
import { fromSpawnError } from './errors.js';
import type { ShellExecutor, ShellResult, ShellRunOptions } from './executor.js';

export interface NodeShellExecutorOptions {
  /** Default working directory for a run that does not set one. */
  readonly cwd?: string;
  /** Default timeout in ms. 30_000. A run that hangs must not hang forever. */
  readonly timeoutMs?: number;
  /** Default output cap in bytes. 1 MiB. A run that floods must not exhaust memory. */
  readonly maxOutputBytes?: number;
  /**
   * A clock, so `durationMs` is deterministic in a test.
   *
   * Injected for the reason the kernel injects one: a duration from `Date.now()`
   * makes a result differ every run, and a checkpoint of it differ with it.
   */
  readonly now?: () => number;
  /**
   * How long to wait after SIGTERM before escalating to SIGKILL, in ms. 2000.
   *
   * Configurable so a test can verify the escalation without waiting two seconds
   * — a process that ignores SIGTERM must still die, and that guarantee is worth
   * exercising rather than asserting.
   */
  readonly killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export class NodeShellExecutor implements ShellExecutor {
  readonly #options: NodeShellExecutorOptions;
  readonly #now: () => number;

  constructor(options: NodeShellExecutorOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  run(
    command: string,
    args: readonly string[],
    options: ShellRunOptions = {},
  ): Promise<ShellResult> {
    const timeoutMs =
      options.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes =
      options.maxOutputBytes ??
      this.#options.maxOutputBytes ??
      DEFAULT_MAX_OUTPUT_BYTES;
    const startedAt = this.#now();

    return new Promise<ShellResult>((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error('Aborted before the command started'));
        return;
      }

      const child = spawn(command, [...args], {
        // The whole security posture, in three fields: no shell to interpret a
        // string, a chosen cwd, and a chosen environment — never the ambient one,
        // which carries the host's secrets (see ShellRunOptions.env).
        shell: false,
        cwd: options.cwd ?? this.#options.cwd,
        // The subtle one. `spawn` with `env: undefined` *inherits* the parent's
        // whole environment — Node only isolates when handed an explicit object.
        // So an absent `env` is not "no environment", it is "all of the host's
        // secrets", which is the opposite of safe. The default is therefore a
        // deliberate minimal environment: just `PATH`, so the command can still
        // be found, and nothing else. A caller that needs more passes it.
        env: options.env ?? { PATH: process.env['PATH'] ?? '' },
        // `pipe` so output is captured rather than inherited onto the host's
        // stdio, where it would leak into the host's logs and escape the cap.
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      let truncated = false;
      let settled = false;

      const finish = (result: () => ShellResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result());
      };

      // SIGTERM first — a well-behaved process cleans up and exits. The result is
      // reported when the process actually ends (`close`), so a process that
      // ignores SIGTERM is escalated to SIGKILL below.
      const kill = (): void => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, this.#options.killGraceMs ?? DEFAULT_KILL_GRACE_MS).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      timer.unref();

      const onAbort = (): void => {
        kill();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const capture = (chunk: Buffer, onto: (text: string) => void): void => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          truncated = true;
          kill();
          return;
        }
        onto(chunk.toString('utf8'));
      };

      child.stdout.on('data', (chunk: Buffer) => {
        capture(chunk, (text) => {
          stdout += text;
        });
      });
      child.stderr.on('data', (chunk: Buffer) => {
        capture(chunk, (text) => {
          stderr += text;
        });
      });

      // A spawn that fails (ENOENT, EACCES) emits `error` and never `close`. This
      // rejects, because the command did not run — distinct from a command that
      // ran and failed, which resolves with a non-zero code.
      child.on('error', (thrown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(fromSpawnError(command, thrown));
      });

      child.on('close', (exitCode, closeSignal) => {
        finish(() => ({
          command,
          args: [...args],
          exitCode,
          signal: closeSignal,
          stdout,
          stderr,
          timedOut,
          truncated,
          durationMs: this.#now() - startedAt,
        }));
      });

      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        // Closed rather than left open: a command that reads stdin (a `cat` with
        // no file) would otherwise block forever waiting for input that never
        // comes, and the timeout would be the only thing that ended it.
        child.stdin.end();
      }
    });
  }
}
