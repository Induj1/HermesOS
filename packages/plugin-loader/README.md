# @hermes/plugin-loader

Validates plugin manifests and API-version compatibility, then adapts plugins to
the kernel `Plugin` shape — the point where declared versioning is enforced.

- **Design record:** [RFC-0032](../../docs/rfcs/RFC-0032-plugin-loader.md).
- **Depends on:** `@hermes/kernel`, `@hermes/plugin-sdk`.

## Usage

```ts
import { SDK_API_VERSION } from '@hermes/plugin-sdk';
import { PluginLoader } from '@hermes/plugin-loader';

const loader = new PluginLoader({ hostApiVersion: SDK_API_VERSION });

const { loaded, rejected } = loader.load(discoveredPlugins);
for (const r of rejected) {
  logger.warn('plugin rejected', { name: r.name, reasons: r.reasons });
}
for (const plugin of loaded) runtime.use(plugin); // kernel Plugins

// …or fail fast if any plugin is bad:
const plugins = loader.loadOrThrow(discoveredPlugins);
```

## What it enforces

- **API compatibility** (`isApiCompatible`): same major, host ≥ plugin — a 1.2
  plugin runs on a 1.5 host, but not a 1.3 plugin or a 2.0 one.
- **Manifest validity**: non-empty name, semver `version`/`apiVersion`, valid
  host version.
- **No duplicate names** (first wins, later rejected).

`load` reports every rejection with all its reasons (never silently drops one);
`loadOrThrow` throws a `PluginLoadError` instead. Dependency ordering and cycle
detection stay with the kernel runtime — the loader only adapts `dependsOn`
through.
