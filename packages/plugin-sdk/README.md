# @hermes/plugin-sdk

The versioned authoring contract for third-party Hermes plugins — a manifest
(with an API-version declaration) plus `definePlugin`.

- **Design record:** [RFC-0031](../../docs/rfcs/RFC-0031-plugin-sdk.md).
- **Depends on:** `@hermes/kernel` (the `PluginContext`).

## Usage

```ts
import { SDK_API_VERSION, definePlugin } from '@hermes/plugin-sdk';

export default definePlugin(
  {
    name: 'weather',
    version: '1.2.0',
    apiVersion: SDK_API_VERSION,
    description: 'Weather lookup tools',
    author: 'acme',
  },
  (ctx) => {
    ctx.registerTool(getForecast);
    ctx.logger.info('weather plugin ready');
  },
);
```

## Notes

- The `setup` function receives the kernel `PluginContext` unchanged
  (`registerTool`, `registerAgent`, `bus`, `logger`, `clock`, `onDispose`) — the
  SDK adds versioning, not a smaller sandbox.
- `apiVersion` is what lets [`@hermes/plugin-loader`](../plugin-loader) reject
  an incompatible plugin **before** its `setup` runs.
- `isHermesPlugin(value)` is a structural guard for a host that loads plugins
  dynamically.
