# HermesOS API — a reproducible multi-stage production image.
#
# Stage `build` compiles the whole pnpm workspace once; stage `runtime` carries
# only the API service plus its *production* dependencies, isolated by
# `pnpm deploy`, so the shipped image has no source, no devDependencies, and no
# other package's tests. Configuration is read entirely from the environment at
# runtime (see @hermes/config and docs/deployment) — nothing is baked in.
#
# NOTE: This image is authored but not built in the sandbox (no Docker daemon).
# Verification — `docker build -t hermes-api .` and a container run answering
# `/livez` — is the one infra-gated step, documented in STATUS.md.

FROM node:22-slim AS build
ENV HUSKY=0
RUN corepack enable
WORKDIR /app

# Copy the whole workspace and install against the frozen lockfile, then build
# every package (apps/api depends on the built dist of the @hermes/* packages).
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Produce a self-contained deployment of just the API and its prod deps.
# `--legacy` is required from pnpm v10+: it deploys workspace packages by copying
# their built output rather than requiring `inject-workspace-packages=true`.
RUN pnpm --filter @hermes/api deploy --legacy --prod /prod/api

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only the isolated deployment — dist + production node_modules, nothing else.
COPY --from=build /prod/api ./

EXPOSE 3000

# Run as the unprivileged user the base image ships, never root.
USER node

# Liveness from inside the container, using Node's global fetch (the slim image
# has no curl/wget). A non-2xx or a connection error exits non-zero.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
