/**
 * @hermes/plugin-loader — Validate and adapt Hermes plugins for the kernel.
 *
 * ```ts
 * import { SDK_API_VERSION } from '@hermes/plugin-sdk';
 * import { PluginLoader } from '@hermes/plugin-loader';
 *
 * const loader = new PluginLoader({ hostApiVersion: SDK_API_VERSION });
 * const { loaded, rejected } = loader.load(discoveredPlugins);
 * for (const r of rejected) logger.warn('plugin rejected', { name: r.name, reasons: r.reasons });
 * for (const plugin of loaded) runtime.use(plugin); // kernel Plugins
 * ```
 *
 * The loader is where a plugin's *declared* API version is *enforced*: an
 * incompatible or malformed plugin is rejected with a reason before the kernel
 * runs its `setup`.
 */

export {
  PluginLoadError,
  PluginLoader,
  toKernelPlugin,
  type LoadResult,
  type LoaderOptions,
  type RejectedPlugin,
} from './loader.js';

export {
  compareVersions,
  isApiCompatible,
  parseVersion,
  type Version,
} from './semver.js';
