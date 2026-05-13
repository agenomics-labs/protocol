# MCP server hosted-mode image.
#
# Builds and runs `mcp-server/dist/index.js` with AEP_MCP_TRANSPORT=http.
# The HTTP transport (ADR-083 + ADR-132) requires AEP_MCP_AUTH_TOKEN >= 16 bytes;
# operators MUST set it at deploy time (Fly secrets / Railway variables / etc.).
#
# Build context: the repo root (NOT mcp-server/), because the four workspace
# packages mcp-server depends on live above it.
#
#   docker build -f mcp-server/Dockerfile -t aep-mcp .
#
FROM node:20-bookworm-slim AS build

WORKDIR /app

# 0) Pin npm to the version the lockfile was generated with. node:20-bookworm-slim
#    ships npm 10.8.2; our package-lock.json is written by npm 11, and the
#    cross-version `npm ci` strict-mode check rejects the lockfile shape
#    (observed: "Missing: utf-8-validate@5.0.10 from lock file" on Render).
RUN npm install -g npm@11.14.1

# 1) Copy every workspace package.json so `npm ci` can resolve the full graph.
#    We don't copy source yet — that lets the npm-ci layer cache hit on
#    dependency-only changes.
COPY package.json package-lock.json ./
COPY sdk/idl/package.json sdk/idl/
COPY sdk/action-runtime/package.json sdk/action-runtime/
COPY sdk/client/package.json sdk/client/
COPY packages/capability-manifest-validator/package.json packages/capability-manifest-validator/
COPY packages/sas-resolver/package.json packages/sas-resolver/
COPY mcp-server/package.json mcp-server/
COPY src/indexer/package.json src/indexer/
COPY src/x402-relay/package.json src/x402-relay/
COPY dashboard/package.json dashboard/

# 2) Install workspace deps. `--ignore-scripts` skips the root postinstall
#    (which would try to build packages whose source isn't here yet).
RUN npm ci --ignore-scripts

# 3) Copy source for the four packages that get built into the image.
#    sdk/idl is needed at build-time because mcp-server's prebuild reads
#    sdk/idl/src/idl/agent_vault.json to generate vault-layout.generated.ts
#    (see MCP-313 / ADR-119).
COPY sdk/idl sdk/idl/
COPY sdk/action-runtime sdk/action-runtime/
COPY packages packages/
COPY mcp-server mcp-server/

# 4) Build the dependency chain explicitly (same as the root postinstall
#    but without the `--if-present` indirection).
RUN npm -w @agenomics/action-runtime \
        -w @agenomics/capability-manifest-validator \
        -w @agenomics/sas-resolver \
        run build && \
    npm -w @agenomics/mcp-server run build

# 5) Prune dev dependencies so the runtime image stays small. The build
#    artifacts (dist/) are already produced.
RUN npm prune --omit=dev --workspaces

# ----- Runtime stage -----
FROM node:20-bookworm-slim

WORKDIR /app

# Run as a non-root user. Node images ship a `node` uid 1000 we can reuse.
USER node

COPY --from=build --chown=node:node /app /app

# Hosted-mode defaults. AEP_MCP_AUTH_TOKEN is INTENTIONALLY UNSET — the
# transport posture detector hard-fails if it's missing, which is the
# safe default for an HTTP-exposed tx-signing surface.
ENV AEP_MCP_TRANSPORT=http \
    AEP_MCP_HTTP_HOST=0.0.0.0 \
    AEP_MCP_HTTP_PORT=8080 \
    AEP_MCP_HTTP_ALLOWED_ORIGINS=https://claude.ai \
    SOLANA_RPC_URL=https://api.devnet.solana.com \
    SOLANA_KEYPAIR_PATH=/secrets/wallet.json \
    METRICS_PORT=9101 \
    NODE_ENV=production

EXPOSE 8080 9101

WORKDIR /app/mcp-server
CMD ["node", "dist/index.js"]
