# RFC-0024: Configuration

| Field         | Value                                |
| ------------- | ------------------------------------ |
| Status        | Implemented                          |
| Date          | 2026-07-18                           |
| Scope         | `packages/config` (`@hermes/config`) |
| Depends on    | — (zero dependencies)                |
| Supersedes    | —                                    |
| Superseded by | —                                    |

Design record for typed, validated configuration loaded from the environment.

Covered by 34 tests in `packages/config/tests`.

---

## 1. Context

Every service (#22 worker, #24 REST, #25 CLI) and the Docker image (#36) reads
its settings from the environment: a port, a database URL, a log level, an API
key. Reading `process.env.PORT` inline in each service is how a typo becomes a
3am incident — an unset variable is `undefined`, a bad one is a string, and the
failure surfaces far from the cause. This package makes configuration a
**declared schema**: each service states the variables it needs and their types
once, and gets back either a fully typed object or a complete, actionable list
of what is wrong.

It is a **zero-dependency** package. Validation here is a few hundred lines of
parsing; pulling in `zod` or `convict` would add a dependency (and its
transitive surface) to every service for what the type system and a handful of
parsers already do.

## 2. Fields

A `Field<T>` is the typed, parseable unit a schema is built from. Builders cover
what environment variables actually hold: `string`, `number`, `integer`, `port`
(1..65535), `boolean` (`true/false`, `1/0`, `yes/no`, `on/off`, any case),
`url`, `oneOf([...])` (a closed set, narrowed to a union type), and `list` (a
comma-separated list). Each field knows three things:

1. **How to parse** one raw string into a `T`. Parsing never throws — it returns
   a `ParseResult<T>` (`ok` or a human message), so the loader can gather every
   error in one pass instead of dying on the first.
2. **What to do when the variable is unset** — required (an error),
   `.default(v)` (a fixed value), or `.optional()` (`undefined`). A
   whitespace-only value is treated as unset, because `PORT=""` in a shell or
   `.env` means "I did not set this", not "the empty string".
3. **Metadata** — the env-var override (`.from(...)`), whether it is a
   `.secret()`, and a `.describe(...)` line — enough to document and safely
   redact itself.

Fields are **immutable**: every modifier returns a new field, so a schema shared
across modules can never be mutated out from under a caller.

### 2.1 Variance

`Field<T>` is deliberately kept **covariant** in `T` so a concrete
`Field<string>` is assignable to the `Field<unknown>` a `Schema` stores. That
rules out any `(value: T) => …` stored as a _property_ (a contravariant
position). The one place a `T` value is rendered — a default's doc label — uses
`String(value)`, which also renders a `list` default comma-joined (`['a','b']` →
`a,b`), so no per-type renderer is needed. `resolve` and `.default` take `T` as
_method_ parameters, which TypeScript checks bivariantly, so they do not break
the assignment.

## 3. Loading

A `Schema` maps property names to fields; `loadConfig(schema, env)` resolves
each field against an injected environment record and returns either the typed
`Config<S>` or **every** `FieldError` found — one pass, so an operator fixing a
misconfigured deployment sees all the problems at once rather than one restart
per typo. The environment variable for a field is its explicit `.from(...)`
name, or the property key in SCREAMING_SNAKE_CASE (`databaseUrl` →
`DATABASE_URL`). `loadConfigOrThrow` is the fail-fast form, raising a
`ConfigError` whose message lists every problem and whose `.errors` carries the
structured detail.

## 4. Determinism and the environment boundary

`loadConfig` and the fields are a **pure function of an injected record**
(`EnvSource = Record<string, string | undefined>`) — no `process.env`, no I/O —
so every parsing and validation branch is tested against a plain object with no
global state. The single module that touches `process.env` is `env.ts`
(`processEnv`, `loadConfigFromEnv`), mirroring the port/adapter split every
other package uses (`rest/node.ts`, the provider transports).

## 5. Documentation and redaction

Two helpers read a schema for operations:

- `describeSchema(schema)` returns a doc row per field — key, env var, type,
  required, default, secret, description — **purely from the schema, with no
  values**, so the configuration reference (#41) can be generated at any time.
- `redactedView(schema, value)` renders loaded configuration as strings with
  `.secret()` fields masked to `***` regardless of length, so a service can log
  its effective configuration on boot without leaking a key. This is the seam
  Secrets (#31) builds on.

## 6. Non-goals

- **No file or remote loading.** The environment is the single source; a `.env`
  file is the deployment's job to export (Docker/Compose, #36). Layering file →
  env → flags can compose on top later without changing this core.
- **No coercion beyond the declared parsers.** A field is exactly one type; if a
  value does not parse, it is an error, not a silent default.
- **No reload/watch.** Configuration is read once at startup. A running service
  that must change settings restarts — the twelve-factor default — which keeps
  this package a pure loader.

## 7. Testing

34 tests: every field parser (valid and invalid), the three missing-value
behaviours, trimming, immutability of modifiers, env-var derivation, the
all-errors-at-once guarantee, `.from()` overrides, `describeSchema`,
`redactedView` (secret masked, unset blank, list joined), and the `process.env`
adapter. 100% branch coverage.
