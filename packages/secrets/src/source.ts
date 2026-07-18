/**
 * Secret sources — where a secret value is read from.
 *
 * A `SecretSource` is a port: `load(name)` yields the raw value or `undefined`
 * when this source does not have it. Adapters cover the ways a deployment
 * actually delivers secrets:
 *
 * - `MemorySecretSource` — an in-memory map; the deterministic test double.
 * - `EnvSecretSource` — a process-environment record, with the Docker/Compose
 *   `NAME_FILE` indirection (a variable pointing at a mounted secret file).
 * - `FileSecretSource` — a directory of one-file-per-secret, the shape Docker
 *   and Kubernetes secret mounts take (`/run/secrets/<name>`).
 * - `ChainSecretSource` — try several sources in order; first hit wins.
 *
 * File and environment access is injected (`FileReader`, the env record), so the
 * whole module is a pure function of its inputs and every branch is testable
 * without touching real I/O. The Node-backed `FileReader` lives in `node.ts`.
 */

/** A record read from the process environment (or a test double). */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Reads a file's contents, or `undefined` when the file does not exist. */
export type FileReader = (path: string) => Promise<string | undefined>;

/** A place secret values are read from. */
export interface SecretSource {
  /** The raw value for `name`, or `undefined` when this source lacks it. */
  load(name: string): Promise<string | undefined>;
}

/** Treat a blank or whitespace-only value as absent — an unset variable, not "". */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? undefined : value;
}

/** An in-memory map of secrets — the deterministic test double. */
export class MemorySecretSource implements SecretSource {
  readonly #entries: EnvRecord;

  constructor(entries: EnvRecord) {
    this.#entries = entries;
  }

  load(name: string): Promise<string | undefined> {
    return Promise.resolve(present(this.#entries[name]));
  }
}

/**
 * A process-environment record. Supports the Docker/Compose `NAME_FILE`
 * convention: if `NAME` is unset but `NAME_FILE` points at a file, its trimmed
 * contents are the secret — the standard way to keep a secret out of the
 * environment (and out of `docker inspect`) while still injecting it.
 */
export class EnvSecretSource implements SecretSource {
  readonly #env: EnvRecord;
  readonly #readFile: FileReader | undefined;

  constructor(env: EnvRecord, readFile?: FileReader) {
    this.#env = env;
    this.#readFile = readFile;
  }

  async load(name: string): Promise<string | undefined> {
    const direct = present(this.#env[name]);
    if (direct !== undefined) return direct;

    const filePath = present(this.#env[`${name}_FILE`]);
    if (filePath === undefined || this.#readFile === undefined) return undefined;
    const contents = await this.#readFile(filePath);
    return present(contents?.trim());
  }
}

/**
 * A directory of one-file-per-secret (`<dir>/<name>`), the shape of a Docker or
 * Kubernetes secret mount. The file's trimmed contents are the value.
 */
export class FileSecretSource implements SecretSource {
  readonly #dir: string;
  readonly #readFile: FileReader;

  constructor(dir: string, readFile: FileReader) {
    // Normalize a single trailing slash so `dir` + `/` + `name` is clean.
    this.#dir = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    this.#readFile = readFile;
  }

  async load(name: string): Promise<string | undefined> {
    const contents = await this.#readFile(`${this.#dir}/${name}`);
    return present(contents?.trim());
  }
}

/** Try each source in order; the first to have the secret wins. */
export class ChainSecretSource implements SecretSource {
  readonly #sources: readonly SecretSource[];

  constructor(sources: readonly SecretSource[]) {
    this.#sources = sources;
  }

  async load(name: string): Promise<string | undefined> {
    for (const source of this.#sources) {
      const value = await source.load(name);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}
