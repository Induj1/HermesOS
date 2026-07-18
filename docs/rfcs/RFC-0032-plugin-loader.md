# RFC-0032: Plugin Loader

| Field         | Value                                              |
| ------------- | -------------------------------------------------- |
| Status        | Implemented                                        |
| Date          | 2026-07-18                                         |
| Scope         | `packages/plugin-loader` (`@hermes/plugin-loader`) |
| Depends on    | `@hermes/kernel`, `@hermes/plugin-sdk`             |
| Supersedes    | —                                                  |
| Superseded by | —                                                  |

Design record for validating plugin manifests and API compatibility, then
adapting plugins to the kernel `Plugin`.

Covered by 18 tests in `packages/plugin-loader/tests`.

---

## 1. Context

The SDK (#28) lets a plugin **declare** its version and the API version it
targets. This package is where those declarations are **enforced** — the point
the roadmap's "tool/plugin versioning is declared, not enforced" limitation
(RFC-0006 §7.3) is closed. A plugin built for a host it cannot run on fails at
**load**, with a reason, rather than as a crash inside `setup`.

It sits between discovery and the kernel: given a set of `HermesPlugin`s, it
validates each and adapts the survivors to the kernel `Plugin` shape that
`runtime.use()` consumes. It never runs `setup` itself — that is the runtime's
job; the loader only decides what is _allowed_ to run.

## 2. Compatibility

`isApiCompatible(host, plugin)` applies standard semver rules to the API
version: the **major must match** (a major bump is breaking), and the host must
be **at least** the plugin's version (a plugin using a 1.3 feature must not load
on a 1.2 host, but a 1.2 plugin loads fine on 1.5). The `semver.ts` helper
implements only that one question — parse, compare, compatible — rather than a
full range grammar (`^`, `~`, `||`, pre-release), so the package stays
zero-dependency; a fuller grammar can replace it behind the same functions if a
real need appears.

## 3. Validation and adaptation

`load(plugins)` checks each plugin for: an empty name, a duplicate name (the
first wins, later ones are rejected), an invalid `version`, an invalid
`apiVersion`, an invalid **host** version, and API incompatibility. Every
surviving plugin is adapted by `toKernelPlugin` — the manifest's `name`,
`version`, and `dependsOn` map onto the kernel `Plugin`, and `setup` is
delegated through. `dependsOn` is omitted (not set to `undefined`) when absent,
so the kernel plugin matches the shape a hand-written one has under
`exactOptionalPropertyTypes`.

## 4. Report, don't crash

Two failure philosophies, and the loader offers both:

- `load` is **all-or-reported**: it returns the adapted plugins _and_ a
  structured `rejected` list, each entry naming the plugin and **every** reason
  it failed (not just the first) — so a host can log the bad ones and run the
  good ones, and an operator fixing a plugin sees all its problems at once.
- `loadOrThrow` is the **fail-fast** form: any rejection throws a
  `PluginLoadError` whose message lists them and whose `.rejected` carries the
  detail — for a host where a bad plugin must abort startup.

Neither silently drops a plugin: a rejection is always visible, because a plugin
that vanishes without a word is the hardest kind of failure to diagnose.

## 5. Non-goals

- **No discovery or dynamic import.** _Where_ plugins come from — a directory
  scan, an npm resolve, a registry fetch — is the host's concern; this validates
  and adapts the in-memory set it is handed. `isHermesPlugin` (from the SDK) is
  the guard a discovery layer uses on an untrusted `default` export.
- **No dependency ordering.** The kernel runtime already topologically sorts on
  `dependsOn` and rejects cycles/missing deps; duplicating that here would be a
  second source of truth. The loader only adapts `dependsOn` through.
- **No sandboxing.** A loaded plugin runs with the full `PluginContext`;
  isolating an untrusted plugin (a worker, a capability filter) is a larger
  concern than version enforcement and is out of scope.

## 6. Testing

18 tests: `semver` parse (valid, and rejecting `1.2`, pre-release, `v`-prefix,
junk), compare, and compatibility (major mismatch both directions, host-newer,
equal, plugin-newer); and the loader's valid adaptation (incl. `dependsOn`
mapped and omitted), incompatible-version rejection, all-reasons-for-one-plugin,
duplicate-name, invalid-host-version, and both `loadOrThrow` outcomes plus
`toKernelPlugin` setup delegation. 100% branch coverage.
