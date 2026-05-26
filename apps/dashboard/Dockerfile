# Dashboard image (Next.js standalone) — built from the repo root.
#   docker build -f apps/dashboard/Dockerfile -t agent-swarm/dashboard:dev .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @agent-swarm/dashboard
COPY apps/dashboard ./apps/dashboard
RUN pnpm --filter @agent-swarm/dashboard build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# Standalone output is traced from the repo root (outputFileTracingRoot), so the
# server entry lands at apps/dashboard/server.js with node_modules at the root.
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
