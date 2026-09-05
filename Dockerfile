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
#
# Invoke the CLI via its own script rather than `npx playwright`: apps/web's
# devDependency on @playwright/test wins the shared node_modules/.bin/playwright
# symlink over packages/core's plain `playwright` dependency, and the builder
# stage's `npm prune --omit=dev` then deletes @playwright/test (dev-only),
# leaving that symlink dangling — `npx playwright` fails with
# "sh: 1: playwright: not found" even though the `playwright` package itself
# (a real, non-dev dependency) is right there.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8787
# --max-old-space-size caps V8's heap well below typical free/starter-tier container memory
# limits (e.g. Render's 512MB) instead of letting it grow toward a much larger default based on
# the host's total visible memory — without this, idle heap growth alone can trip the platform's
# OOM killer over a period of hours even with zero active sessions, since V8 doesn't proactively
# shrink the heap back down; a lower ceiling forces GC to reclaim memory sooner. Tuned to leave
# headroom for non-heap memory (buffers, native modules, thread stacks) plus whatever a spawned
# git/npm/pytest child process or headless Chromium instance (browser_check) needs alongside it —
# raise this (or the container's memory limit) if deploying with more RAM available.
CMD ["node", "--max-old-space-size=350", "apps/server/dist/index.js"]
