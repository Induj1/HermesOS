# RFC-0031: Plugin SDK

| Field         | Value                                        |
| ------------- | -------------------------------------------- |
| Status        | Implemented                                  |
| Date          | 2026-07-18                                   |
| Scope         | `packages/plugin-sdk` (`@hermes/plugin-sdk`) |
| Depends on    | `@hermes/kernel` (`PluginContext`)           |
| Supersedes    | —                                            |
| Superseded by | —                                            |

Design record for the versioned authoring contract third-party plugins
implement.

Covered by 4 tests in `packages/plugin-sdk/tests`.

---

## 1. Context

The kernel already has a plugin system (RFC-0001): a `Plugin` is
`{ name, version?, dependsOn?, setup(ctx) }`, and the runtime topologically
orders them, runs `setup`, and unwinds disposal. A **first-party** capability is
defined directly against it.

A **third-party** plugin — shipped separately, versioned on its own cadence,
built against whatever SDK version was current at the time — needs one thing the
raw kernel `Plugin` does not carry: a declaration of **which API version it was
built against**. Without it, an incompatible plugin fails as a crash inside
`setup`; with it, the loader (#29) can refuse the plugin up front, with a clear
reason. This package is that thin versioned layer, and nothing more.

## 2. The manifest

`PluginManifest` is the metadata a plugin declares: its `name` (also its key in
another plugin's `dependsOn`), its own `version`, the `apiVersion` it targets,
and optional `description`/`author`/`dependsOn`. `SDK_API_VERSION` is the
current contract version a plugin sets `apiVersion` to; its **major** bumps on a
breaking change to `PluginContext` or the manifest, its **minor** on an additive
one — which is exactly what the loader's compatibility check keys on.

## 3. Reusing the kernel context

A `HermesPlugin`'s `setup` receives the kernel `PluginContext` **unchanged** —
`registerTool`, `registerAgent`, the event `bus`, a name-tagged `logger`, the
`clock`, and `onDispose`. The SDK deliberately does not wrap or narrow it: a
third-party plugin can do everything a first-party one can. The SDK adds
versioning, not a smaller sandbox. `definePlugin(manifest, setup)` pairs the
two, and `isHermesPlugin` is a structural guard for a loader that discovers
plugins dynamically (a `default` export from a module it did not write).

## 4. Non-goals

- **No packaging/distribution format.** How a plugin is discovered (an npm
  package, a directory, a registry) is the loader's and host's concern. This is
  the in-memory contract.
- **No capability model beyond the kernel's.** Tools and agents register through
  the existing `PluginContext`; a richer capability (a transport, a store) is a
  kernel concern, and this SDK rides whatever the context exposes.
- **No runtime enforcement.** The manifest only _declares_; enforcing the
  declaration (compatibility, duplicates, validity) is the loader's job (#29),
  kept separate so authoring stays dependency-light.

## 5. Testing

4 tests: `definePlugin` carries the manifest and runs `setup`; `SDK_API_VERSION`
is semver; and `isHermesPlugin` accepts a real plugin and rejects each malformed
shape (null, a string, manifest-without-setup, setup-without-manifest, a null
manifest). 100% branch coverage.
