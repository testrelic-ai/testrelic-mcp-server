# syntax=docker/dockerfile:1.7
# Multi-stage image for @testrelic/mcp.
# Produces a ~180MB image with native deps precompiled.

FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Install toolchain for better-sqlite3 + hnswlib-node native builds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Workspace package manifests are copied first for cache reuse.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/mcp/package.json packages/mcp/
COPY packages/extension/package.json packages/extension/

# Install all deps including devDependencies so tsc is available for the build step.
# NODE_ENV is intentionally NOT set to production here; it is set in the runtime stage.
RUN npm ci --workspace @testrelic/mcp --include-workspace-root

# Sources.
COPY tsconfig.json ./
COPY packages/mcp ./packages/mcp
RUN npm --workspace @testrelic/mcp run build \
    && npm --workspace @testrelic/mcp prune --omit=dev

# ─── Runtime stage ─────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_IN_DOCKER=1

# libstdc++ runtime for native modules.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/mcp/package.json ./packages/mcp/package.json
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=builder /app/packages/mcp/node_modules ./packages/mcp/node_modules
COPY --from=builder /app/packages/mcp/README.md ./packages/mcp/README.md

# Default caches in a writable location.
ENV TESTRELIC_MCP_CACHE_DIR=/data/cache
ENV TESTRELIC_MCP_OUTPUT_DIR=/data/output
# The server runs as the image's unprivileged `node` user; /data is the only
# place it writes (cache + output), so that is the only tree it owns.
RUN mkdir -p /data/cache /data/output && chown -R node:node /data
VOLUME ["/data"]

EXPOSE 3000
USER node
ENTRYPOINT ["node", "packages/mcp/dist/cli.js"]
CMD ["--port", "3000", "--host", "0.0.0.0"]
