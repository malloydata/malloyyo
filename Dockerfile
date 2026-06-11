# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --config.strict-dep-builds=false

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="postgresql:///" \
    MOTHERDUCK_TOKEN="dummy"
RUN pnpm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
