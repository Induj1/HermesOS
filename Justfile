# HermesOS task runner. Run `just` to list every recipe.
#
# Install just: https://github.com/casey/just#installation
#   macOS: brew install just

set dotenv-load := true
set dotenv-required := false
set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments := true

# Minimum toolchain versions enforced by `just doctor`.
node_major_min := "22"
compose := "docker compose"

# Show all available recipes.
default:
    @just --list --unsorted

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

# One-shot bootstrap for a fresh clone: verify tools, seed .env, install deps, provision the DB, pull models.
setup: doctor env-init
    @echo "==> Installing workspace dependencies"
    pnpm install --frozen-lockfile || pnpm install
    @just db-init
    @just ollama-pull
    @echo ""
    @echo "Setup complete. Next: just dev"

# Verify the host toolchain is present and new enough.
doctor:
    #!/usr/bin/env bash
    set -euo pipefail
    fail=0
    need() {
        if ! command -v "$1" >/dev/null 2>&1; then
            echo "  missing: $1 — $2"
            fail=1
        fi
    }
    echo "==> Checking toolchain"
    need node      "install Node.js >= {{ node_major_min }} (https://nodejs.org)"
    need pnpm      "corepack enable && corepack prepare pnpm@latest --activate"
    need psql      "brew install postgresql@17"
    need redis-cli "brew install redis"
    need ollama    "brew install ollama"
    if command -v node >/dev/null 2>&1; then
        major="$(node -p 'process.versions.node.split(".")[0]')"
        if (( major < {{ node_major_min }} )); then
            echo "  node $major is too old — need >= {{ node_major_min }}"
            fail=1
        fi
    fi
    # Docker is not needed for day-to-day development — only for the opt-in
    # `containerized` compose profile — so a missing Docker is a note, not a failure.
    if ! command -v docker >/dev/null 2>&1; then
        echo "  note: docker not found — only needed for 'just docker-up'"
    elif ! docker compose version >/dev/null 2>&1; then
        echo "  note: docker compose v2 not found — only needed for 'just docker-up'"
    fi
    if (( fail )); then
        echo "==> Toolchain incomplete. Fix the items above and re-run."
        exit 1
    fi
    echo "==> Toolchain OK"

# Create .env from .env.example, generating real secrets. Never overwrites an existing .env.
env-init:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -f .env ]]; then
        echo "==> .env already exists, leaving it alone"
        exit 0
    fi
    echo "==> Creating .env from .env.example"
    # Build in a temp file and move into place only on success. A partial .env
    # would be protected by the guard above and silently keep CHANGE_ME secrets.
    tmp="$(mktemp .env.tmp.XXXXXX)"
    trap 'rm -f "$tmp"' EXIT
    cp .env.example "$tmp"
    # sed -i takes a mandatory suffix arg on BSD/macOS and none on GNU.
    sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
    # Feed tr a finite chunk: `tr </dev/urandom | head` kills tr with SIGPIPE,
    # which pipefail reports as a failure (exit 141).
    gen() { head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-32; }
    pg_pass="$(gen)"
    if [[ ${#pg_pass} -ne 32 ]]; then
        echo "==> Failed to generate credentials" >&2
        exit 1
    fi
    # Rewrite the var and the connection string that embeds it, so a fresh clone
    # never runs on a placeholder password. `just db-init` provisions the native
    # role with this same password.
    #
    # REDIS_PASSWORD is deliberately left empty: the native Homebrew Redis has no
    # requirepass, so generating one here would produce a REDIS_URL that cannot
    # authenticate. The containerized profile prompts for it when you opt in.
    sedi "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pg_pass}|" "$tmp"
    sedi "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://hermes:${pg_pass}@127.0.0.1:5432/hermes|" "$tmp"
    # Assignment lines only — the header comment mentions CHANGE_ME by name.
    if grep -nE '^[^#]*CHANGE_ME' "$tmp" >&2; then
        echo "==> A CHANGE_ME placeholder survived — .env.example and env-init are out of sync" >&2
        exit 1
    fi
    chmod 600 "$tmp"
    mv "$tmp" .env
    trap - EXIT
    echo "==> Generated random credentials in .env"

# ---------------------------------------------------------------------------
# Develop
# ---------------------------------------------------------------------------

# Check the native services are up, then run the app dev servers on the host.
dev *args: services-check
    pnpm run dev "$@"

# Verify the native services this project expects are reachable.
services-check:
    #!/usr/bin/env bash
    set -euo pipefail
    fail=0
    pg_port="${POSTGRES_PORT:-5432}"
    echo "==> Checking services"
    if pg_isready -q -h 127.0.0.1 -p "$pg_port" 2>/dev/null; then
        # Reachable is not the same as provisioned — a stock cluster has no hermes role/db.
        if psql "${DATABASE_URL:?set DATABASE_URL in .env}" -tAc 'select 1' >/dev/null 2>&1; then
            echo "  postgres  ok    127.0.0.1:${pg_port}"
        else
            echo "  postgres  up, but DATABASE_URL will not connect — run: just db-init"
            fail=1
        fi
    else
        echo "  postgres  DOWN  — brew services start postgresql@17"
        fail=1
    fi
    if redis-cli -u "${REDIS_URL:?set REDIS_URL in .env}" ping >/dev/null 2>&1; then
        echo "  redis     ok    ${REDIS_PORT:-6379}"
    else
        echo "  redis     DOWN  — brew services start redis"
        fail=1
    fi
    if curl -fsS -m 3 "${OLLAMA_URL:-http://127.0.0.1:11434}/api/tags" >/dev/null 2>&1; then
        echo "  ollama    ok    ${OLLAMA_URL:-http://127.0.0.1:11434}"
    else
        echo "  ollama    DOWN  — brew services start ollama"
        fail=1
    fi
    if (( fail )); then
        echo "==> Some services are unavailable. Start them above, or run the"
        echo "    containerized stack instead: just docker-up"
        exit 1
    fi

# Provision the hermes role, database, and extensions in the native Postgres. Idempotent.
db-init:
    #!/usr/bin/env bash
    set -euo pipefail
    user="${POSTGRES_USER:?set POSTGRES_USER in .env}"
    pass="${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}"
    db="${POSTGRES_DB:?set POSTGRES_DB in .env}"
    pg_port="${POSTGRES_PORT:-5432}"
    if ! pg_isready -q -h 127.0.0.1 -p "$pg_port" 2>/dev/null; then
        echo "==> Postgres is not accepting connections on 127.0.0.1:${pg_port}" >&2
        echo "    brew services start postgresql@17" >&2
        exit 1
    fi
    # Connects over the local socket as the OS user — a superuser on a Homebrew
    # cluster, which is what creating roles and extensions requires.
    admin=(psql -v ON_ERROR_STOP=1 -q -d postgres)
    # Identifiers and the password go in as psql variables — :"u" quotes an
    # identifier, :'p' a literal — so a generated password can contain anything.
    # These are fed via `-f -`: psql does NOT interpolate variables into `-c`.
    if [[ -z "$("${admin[@]}" -tAc "select 1 from pg_roles where rolname = '$user'")" ]]; then
        echo "==> Creating role $user"
        "${admin[@]}" -v u="$user" -f - <<< 'create role :"u" with login'
    fi
    # Re-applied every run so the role always matches whatever .env holds now.
    "${admin[@]}" -v u="$user" -v p="$pass" -f - <<< "alter role :\"u\" with password :'p'"
    if [[ -z "$("${admin[@]}" -tAc "select 1 from pg_database where datname = '$db'")" ]]; then
        echo "==> Creating database $db owned by $user"
        "${admin[@]}" -v d="$db" -v u="$user" -f - <<< 'create database :"d" owner :"u"'
    fi
    # The native stand-in for the container's docker-entrypoint-initdb.d run.
    # Every file must be idempotent — unlike the container, this re-runs.
    echo "==> Applying infrastructure/postgres/init"
    shopt -s nullglob
    for f in infrastructure/postgres/init/*.sql; do
        echo "    $f"
        psql -v ON_ERROR_STOP=1 -q -d "$db" -f "$f"
    done
    echo "==> Verifying DATABASE_URL"
    psql "${DATABASE_URL:?set DATABASE_URL in .env}" -tAc 'select current_user, current_database()'
    echo "==> Database ready"

# Build all workspace packages.
build *args:
    pnpm run build "$@"

# Run the test suite. Pass a filter: `just test kernel`.
test *args:
    pnpm run test "$@"

# Run tests in watch mode.
test-watch *args:
    pnpm run test:watch "$@"

# Lint with ESLint. `just lint --fix` autofixes what it can.
lint *args:
    pnpm run lint "$@"

# Type-check every package with tsc, without emitting.
typecheck *args:
    pnpm run typecheck "$@"

# Verify formatting without rewriting anything — what CI checks. Use `just fmt` to fix.
fmt-check:
    pnpm run format:check

# Apply formatter and lint autofixes across the workspace.
fmt:
    pnpm run format
    pnpm run lint --fix

# Everything CI runs, plus build and test. Run before pushing.
check: lint fmt-check typecheck build test

# Remove build output and caches. `just clean deps` also drops node_modules.
clean target="":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Removing build artifacts"
    find . -type d \( -name dist -o -name .turbo -o -name coverage \) \
        -not -path './node_modules/*' -prune -exec rm -rf {} +
    if [[ "{{ target }}" == "deps" ]]; then
        echo "==> Removing node_modules"
        find . -type d -name node_modules -prune -exec rm -rf {} +
    fi

# ---------------------------------------------------------------------------
# Docker — the optional `containerized` profile
# ---------------------------------------------------------------------------
#
# Day-to-day development does not need any of this: the services run natively
# via Homebrew. These recipes exist for Linux hosts, CI, and rehearsing the
# production topology. The default compose stack is empty, so every recipe here
# names its profiles explicitly.
#
# Heads up: the containers bind the same ports as the Homebrew services. Stop
# the brew service first, or override the *_PORT vars in .env.

# Start the containerized infrastructure and wait for health. Defaults to the `containerized` profile; pass `gpu` for the NVIDIA Ollama.
docker-up *profiles:
    #!/usr/bin/env bash
    set -euo pipefail
    (( $# )) || set -- containerized
    args=()
    for p in "$@"; do args+=(--profile "$p"); done
    # Fail before pulling images rather than after redis exits on startup.
    if [[ " $* " == *" containerized "* && -z "${REDIS_PASSWORD:-}" ]]; then
        echo "==> REDIS_PASSWORD is empty in .env." >&2
        echo "    Native development runs Redis without a password; this profile will not." >&2
        echo "    Set REDIS_PASSWORD, then update REDIS_URL to" >&2
        echo "    redis://default:<password>@127.0.0.1:6379   (name 'default'; redis-cli 8 rejects an empty username)" >&2
        exit 1
    fi
    # The brew services hold these ports; both cannot bind at once.
    for svc in "postgresql@17:${POSTGRES_PORT:-5432}" "redis:${REDIS_PORT:-6379}" "ollama:${OLLAMA_PORT:-11434}"; do
        name="${svc%%:*}"; port="${svc##*:}"
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            echo "==> Port $port is already in use — stop the native service first:" >&2
            echo "    brew services stop $name" >&2
            exit 1
        fi
    done
    {{ compose }} "${args[@]}" up -d --wait --wait-timeout 180
    echo "==> Infrastructure healthy"
    {{ compose }} "${args[@]}" ps

# Stop the containerized infrastructure. Volumes and data are preserved.
docker-down:
    {{ compose }} --profile containerized --profile gpu down --remove-orphans

# Native Homebrew data is untouched — this only removes Docker volumes.
[doc("Restart the containerized infrastructure from a clean slate. DESTROYS its database, cache, and model data.")]
docker-reset:
    #!/usr/bin/env bash
    set -euo pipefail
    read -r -p "This deletes the containerized Postgres, Redis, and Ollama volumes. Type 'yes' to continue: " reply
    [[ "$reply" == "yes" ]] || { echo "Aborted."; exit 1; }
    {{ compose }} --profile containerized --profile gpu down --volumes --remove-orphans
    just docker-up

# Tail containerized service logs. `just docker-logs postgres` narrows to one service.
docker-logs *args:
    {{ compose }} --profile containerized --profile gpu logs --follow --tail 100 "$@"

# Show container status and health.
docker-ps:
    {{ compose }} --profile containerized --profile gpu ps

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
#
# These drive the host CLIs against the URLs in .env rather than `compose exec`.
# That is deliberate: the URLs point at localhost either way, so one set of
# recipes works against the native services and the containerized profile alike
# — whichever happens to own the port.

# Run the Ollama CLI. No args lists installed models.
#   just ollama pull llama3.2
#   just ollama run llama3.2 "hello"
[doc("Run the Ollama CLI against OLLAMA_URL. No args lists installed models.")]
ollama *args:
    #!/usr/bin/env bash
    set -euo pipefail
    export OLLAMA_HOST="${OLLAMA_URL:-http://127.0.0.1:11434}"
    if (( $# == 0 )); then
        command ollama list
    else
        command ollama "$@"
    fi

# Pull the models listed in OLLAMA_MODELS (comma-separated) from .env.
ollama-pull:
    #!/usr/bin/env bash
    set -euo pipefail
    export OLLAMA_HOST="${OLLAMA_URL:-http://127.0.0.1:11434}"
    models="${OLLAMA_MODELS:-}"
    if [[ -z "$models" ]]; then
        echo "==> OLLAMA_MODELS is empty in .env, nothing to pull"
        exit 0
    fi
    IFS=',' read -ra list <<< "$models"
    for model in "${list[@]}"; do
        model="$(echo "$model" | xargs)"  # trim surrounding whitespace
        [[ -z "$model" ]] && continue
        echo "==> Pulling $model (this can take several minutes)"
        command ollama pull "$model"
    done

# Open psql. With args, they are passed straight through.
#   just postgres
#   just postgres -c 'select version()'
[doc("Open psql on DATABASE_URL. Any args are passed straight through to psql.")]
postgres *args:
    psql "${DATABASE_URL:?set DATABASE_URL in .env}" "$@"

# Dump the database to ./backups/hermes-<label>.sql.
postgres-dump label="snapshot":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p backups
    out="backups/hermes-{{ label }}.sql"
    pg_dump "${DATABASE_URL:?set DATABASE_URL in .env}" > "$out"
    echo "==> Wrote $out"

# Open redis-cli. With args, they are passed straight through.
#   just redis
#   just redis dbsize
[doc("Open redis-cli on REDIS_URL. Any args are passed straight through to redis-cli.")]
redis *args:
    redis-cli -u "${REDIS_URL:?set REDIS_URL in .env}" "$@"

# Delete every key in the Redis database.
redis-flush:
    #!/usr/bin/env bash
    set -euo pipefail
    # The native Redis is shared with anything else on this machine that uses it,
    # so name the target before wiping it.
    echo "Target: ${REDIS_URL:?set REDIS_URL in .env}"
    read -r -p "This flushes all Redis keys. Type 'yes' to continue: " reply
    [[ "$reply" == "yes" ]] || { echo "Aborted."; exit 1; }
    redis-cli -u "$REDIS_URL" flushall
