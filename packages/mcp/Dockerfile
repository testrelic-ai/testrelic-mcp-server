# syntax=docker/dockerfile:1.7
# Multi-stage image for @testrelic/mcp.
# Produces a ~180MB image with native deps precompiled.

FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NODE_ENV=production

# Install toolchain for better-sqlite3 + hnswlib-node native builds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Workspace package manifests are copied first for cache reuse.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/mcp/package.json packages/mcp/
COPY packages/extension/package.json packages/extension/

RUN npm ci --workspace @testrelic/mcp --include-workspace-root

# Sources.
COPY tsconfig.json ./
COPY packages/mcp ./packages/mcp
RUN npm --workspace @testrelic/mcp run build \
    && npm --workspace @testrelic/mcp prune --omit=dev

# ─── Runtime stage ─────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
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
VOLUME ["/data"]

EXPOSE 3000
ENTRYPOINT ["node", "packages/mcp/dist/cli.js"]
CMD ["--port", "3000", "--host", "0.0.0.0"]
