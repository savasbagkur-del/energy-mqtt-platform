# Multi-stage build for the communication monorepo.
# Two runnable targets (selected via compose `target:`): `api` and `worker`.
# Build context MUST be the repository root.

# ---- base: pnpm + node toolchain -------------------------------------------
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build: install all workspace deps and compile TS -> dist --------------
FROM base AS build
# Copy manifests first so the dependency layer caches across source-only changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mqtt/package.json packages/mqtt/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/mqtt-worker/package.json apps/mqtt-worker/package.json
RUN pnpm install --frozen-lockfile
# Now copy the rest of the sources and build every package + app.
COPY . .
RUN pnpm -r build

# ---- api: HTTP API service -------------------------------------------------
FROM base AS api
ENV NODE_ENV=production
# Whole built workspace (node_modules symlinks resolve @communication/* -> dist).
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

# ---- worker: MQTT command/reconcile worker ---------------------------------
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/mqtt-worker
# Worker health/metrics HTTP port (see WORKER_HEALTH_PORT).
EXPOSE 9100
CMD ["node", "dist/main.js"]
