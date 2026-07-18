/**
 * The plugin authoring contract — what a third-party plugin implements.
 *
 * The kernel already has an in-process `Plugin` (`name`, `setup(ctx)`,
 * `dependsOn`), and a first-party capability is often defined directly against
 * it. This SDK adds the layer a *third-party*, separately-versioned plugin
 * needs: a **manifest** that declares, among its metadata, the **API version**
 * it was built against. That declaration is the whole point — it lets the loader
 * (#29) refuse a plugin built for an incompatible host *before* the kernel runs
 * its `setup`, instead of discovering the mismatch as a runtime crash.
 *
 * A `HermesPlugin`'s `setup` receives the kernel `PluginContext` unchanged, so
 * everything a kernel plugin can do (register tools/agents, observe the bus,
 * hook disposal) a HermesPlugin can do — the SDK adds versioning, not a wall.
 */

import type { PluginContext } from '@hermes/kernel';

/**
 * The API version this SDK defines. A plugin sets `apiVersion` to the version it
 * was built against; the loader compares it to the host's. Bump the **major**
 * on a breaking change to `PluginContext`/`PluginManifest`, the **minor** on an
 * additive one.
 */
export const SDK_API_VERSION = '1.0.0';

export interface PluginManifest {
  /** Unique plugin name; also the key other plugins list in `dependsOn`. */
  readonly name: string;
  /** The plugin's own version (semver). */
  readonly version: string;
  /** The SDK API version this plugin targets (semver), e.g. `SDK_API_VERSION`. */
  readonly apiVersion: string;
  /** A one-line human description. */
  readonly description?: string;
  /** Author or vendor, for provenance. */
  readonly author?: string;
  /** Names of plugins that must be set up first. */
  readonly dependsOn?: readonly string[];
}

export interface HermesPlugin {
  readonly manifest: PluginManifest;
  setup(ctx: PluginContext): void | Promise<void>;
}

/** Define a plugin from its manifest and setup function. */
export function definePlugin(
  manifest: PluginManifest,
  setup: (ctx: PluginContext) => void | Promise<void>,
): HermesPlugin {
  return { manifest, setup };
}

/** Structural check that a value is a `HermesPlugin` (has a manifest and setup). */
export function isHermesPlugin(value: unknown): value is HermesPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { manifest?: unknown; setup?: unknown };
  return (
    typeof candidate.setup === 'function' &&
    typeof candidate.manifest === 'object' &&
    candidate.manifest !== null
  );
}
