# Builds and runs the CodeJustWrite backend + PWA as a single deployable
# service. Deploy this to any Dockerfile-based host (Render, Fly.io,
# Railway, etc.) — see README.md for step-by-step instructions.

FROM node:20-slim AS builder
WORKDIR /app

# Copy root package files first
COPY package.json package-lock.json ./

# Copy all workspace source code (required for workspace resolution)
COPY packages/core ./packages/core
COPY apps/cli ./apps/cli
COPY apps/server ./apps/server
COPY apps/web ./apps/web

# Install dependencies - npm install handles workspaces better than npm ci
RUN npm install

# Build all workspaces
RUN npm run build:core && npm run build:server && npm run build:web

# Prune dev dependencies for smaller image
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git is required at runtime: the server shells out to it to clone repos
# and the agent's git/PR tools run inside those clones. python3/pip3 and
# curl are here so run_shell/run_tests aren't limited to a bare Node image
# when working in a non-JS repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# browser_check drives headless Chromium via Playwright. Without this, the
# `playwright` package is present (it's a regular dependency) but no browser
# binary is, so every browser_check call fails at runtime — install the
# matching Chromium build plus its OS-level libraries now.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
