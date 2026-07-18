/**
 * @hermes/plugin-sdk — The versioned authoring contract for Hermes plugins.
 *
 * ```ts
 * import { SDK_API_VERSION, definePlugin } from '@hermes/plugin-sdk';
 *
 * export default definePlugin(
 *   {
 *     name: 'weather',
 *     version: '1.2.0',
 *     apiVersion: SDK_API_VERSION,
 *     description: 'Weather lookup tools',
 *   },
 *   (ctx) => {
 *     ctx.registerTool(getForecast);
 *     ctx.logger.info('weather plugin ready');
 *   },
 * );
 * ```
 *
 * The manifest's `apiVersion` is what lets `@hermes/plugin-loader` reject an
 * incompatible plugin before its `setup` ever runs.
 */

export {
  SDK_API_VERSION,
  definePlugin,
  isHermesPlugin,
  type HermesPlugin,
  type PluginManifest,
} from './plugin.js';
