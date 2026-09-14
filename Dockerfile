# Slopwatch Server — single process serving the API and the built dashboard.
# Build from the repo root: docker build -t slopwatch-server .
FROM oven/bun:1 AS build

WORKDIR /app

# Install dependencies first so source changes don't bust the layer cache.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY listeners/zcode/package.json listeners/zcode/
COPY listeners/claude-code/package.json listeners/claude-code/
COPY packages/cli/package.json packages/cli/
COPY packages/config/package.json packages/config/
COPY packages/events/package.json packages/events/
COPY packages/summary/package.json packages/summary/
COPY packages/buffer/package.json packages/buffer/
COPY packages/listener-shared/package.json packages/listener-shared/
RUN bun install --frozen-lockfile

# Typecheck needs every package's sources (tsgo runs per workspace), but the
# image only ships the server + the built dashboard. Tests and CI stay in the
# developer/CI loop — the listener E2E specs spawn real processes and are not
# container-friendly.
COPY . .
RUN bun run --filter '@slopwatch/web' build

FROM oven/bun:1-slim
WORKDIR /app
# Bun workspaces hoist deps to the root node_modules; @slopwatch/events is
# symlinked from there into packages/, so ship both alongside the server.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/events ./packages/events
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production
EXPOSE 8787
CMD ["bun", "apps/server/src/index.ts"]
