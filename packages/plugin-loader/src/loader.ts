/**
 * The plugin loader — validate manifests and API compatibility, then adapt.
 *
 * A `HermesPlugin` carries a manifest that *declares* its version and the API
 * version it targets. This loader *enforces* those declarations before the
 * kernel ever runs a plugin: it rejects a malformed manifest, an incompatible
 * API version, and a duplicate name, and only then adapts each surviving plugin
 * to the kernel `Plugin` shape for `runtime.use()`. That is the point in the
 * system where "tool/plugin versioning is declared" becomes "…and enforced":
 * a plugin built for a host it cannot run on fails at load, with a clear reason,
 * rather than as a crash inside `setup`.
 *
 * Loading is all-or-reported, never partial-and-silent: `load` returns both the
 * adapted plugins and a structured list of every rejection, so a host chooses
 * whether a bad plugin is fatal or merely skipped (and logged).
 */

import type { Plugin } from '@hermes/kernel';
import type { HermesPlugin } from '@hermes/plugin-sdk';
import { isApiCompatible, parseVersion } from './semver.js';

export interface LoaderOptions {
  /** The host's API version; a plugin's `apiVersion` is checked against it. */
  readonly hostApiVersion: string;
}

/** A plugin that failed validation, with every reason it failed. */
export interface RejectedPlugin {
  readonly name: string;
  readonly reasons: readonly string[];
}

export interface LoadResult {
  /** The plugins that passed, adapted to the kernel `Plugin` shape, in input order. */
  readonly loaded: readonly Plugin[];
  /** Every plugin that failed, with reasons. */
  readonly rejected: readonly RejectedPlugin[];
}

export class PluginLoader {
  readonly #hostApiVersion: string;

  constructor(options: LoaderOptions) {
    this.#hostApiVersion = options.hostApiVersion;
  }

  /** Validate and adapt a set of plugins. Never throws; reports rejections. */
  load(plugins: readonly HermesPlugin[]): LoadResult {
    const host = parseVersion(this.#hostApiVersion);
    const loaded: Plugin[] = [];
    const rejected: RejectedPlugin[] = [];
    const seen = new Set<string>();

    for (const plugin of plugins) {
      const reasons = this.#validate(plugin, host, seen);
      const name = plugin.manifest.name;
      if (reasons.length > 0) {
        rejected.push({ name, reasons });
        continue;
      }
      seen.add(name);
      loaded.push(toKernelPlugin(plugin));
    }

    return { loaded, rejected };
  }

  /**
   * Load and adapt, throwing if any plugin is rejected. Use when a bad plugin
   * should abort startup rather than be skipped.
   */
  loadOrThrow(plugins: readonly HermesPlugin[]): readonly Plugin[] {
    const result = this.load(plugins);
    if (result.rejected.length > 0) {
      const detail = result.rejected
        .map((r) => `  - ${r.name}: ${r.reasons.join('; ')}`)
        .join('\n');
      throw new PluginLoadError(
        `rejected ${String(result.rejected.length)} plugin(s):\n${detail}`,
        result.rejected,
      );
    }
    return result.loaded;
  }

  #validate(
    plugin: HermesPlugin,
    host: ReturnType<typeof parseVersion>,
    seen: ReadonlySet<string>,
  ): string[] {
    const reasons: string[] = [];
    const { name, version, apiVersion } = plugin.manifest;

    if (name.trim() === '') reasons.push('manifest name is empty');
    if (seen.has(name)) reasons.push(`duplicate plugin name "${name}"`);
    if (parseVersion(version) === undefined) {
      reasons.push(`invalid version "${version}"`);
    }

    const pluginApi = parseVersion(apiVersion);
    if (pluginApi === undefined) {
      reasons.push(`invalid apiVersion "${apiVersion}"`);
    } else if (host === undefined) {
      reasons.push(`host apiVersion "${this.#hostApiVersion}" is not valid semver`);
    } else if (!isApiCompatible(host, pluginApi)) {
      reasons.push(
        `apiVersion ${apiVersion} is incompatible with host ${this.#hostApiVersion}`,
      );
    }

    return reasons;
  }
}

/** Adapt an SDK plugin to the kernel `Plugin` the runtime consumes. */
export function toKernelPlugin(plugin: HermesPlugin): Plugin {
  const { name, version, dependsOn } = plugin.manifest;
  return {
    name,
    version,
    ...(dependsOn === undefined ? {} : { dependsOn }),
    setup: (ctx) => plugin.setup(ctx),
  };
}

/** Thrown by `loadOrThrow`; `rejected` carries the structured detail. */
export class PluginLoadError extends Error {
  readonly rejected: readonly RejectedPlugin[];

  constructor(message: string, rejected: readonly RejectedPlugin[]) {
    super(message);
    this.name = 'PluginLoadError';
    this.rejected = rejected;
  }
}
