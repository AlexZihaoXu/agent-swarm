# Combined dashboard image: the gateway (control plane + reverse proxy, :8080)
# and the Next.js dashboard server run together in one container. The gateway
# serves the UI by proxying to the Next server on localhost:3000, so the whole
# control plane is a single container — agents are the only other containers.
#
#   docker build -t agent-swarm/dashboard:dev .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts \
  --filter @agent-swarm/gateway --filter @agent-swarm/dashboard
COPY apps/gateway ./apps/gateway
COPY apps/dashboard ./apps/dashboard
# NEXT_PUBLIC_GATEWAY_URL is intentionally unset → the dashboard calls the
# gateway same-origin (relative URLs), which is correct when served via :8080.
RUN pnpm --filter @agent-swarm/gateway build \
  && pnpm --filter @agent-swarm/dashboard build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# gateway/ — compiled gateway + its runtime deps (flat node_modules).
COPY apps/gateway/package.json ./gateway/package.json
RUN cd gateway && npm install --omit=dev --no-audit --no-fund
COPY --from=build /repo/apps/gateway/dist ./gateway/dist

# dashboard/ — Next.js standalone bundle (self-contained server + node_modules).
# Traced from the repo root, so the entry is apps/dashboard/server.js.
COPY --from=build /repo/apps/dashboard/.next/standalone ./dashboard/
COPY --from=build /repo/apps/dashboard/.next/static ./dashboard/apps/dashboard/.next/static

COPY start.mjs ./start.mjs
EXPOSE 8080
CMD ["node", "start.mjs"]
