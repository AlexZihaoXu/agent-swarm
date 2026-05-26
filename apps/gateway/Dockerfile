# Gateway image — built from the repo root so the pnpm workspace resolves.
#   docker build -f apps/gateway/Dockerfile -t agent-swarm/gateway:dev .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json ./apps/gateway/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @agent-swarm/gateway
COPY apps/gateway ./apps/gateway
RUN pnpm --filter @agent-swarm/gateway build

FROM node:22-slim AS runtime
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/gateway/package.json ./apps/gateway/package.json
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @agent-swarm/gateway
COPY --from=build /repo/apps/gateway/dist ./apps/gateway/dist
WORKDIR /repo/apps/gateway
EXPOSE 8080
CMD ["node", "dist/server.js"]
