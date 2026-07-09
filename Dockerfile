# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install from the lockfile first, keyed only on the manifests, so this layer
# stays cached across source-only changes. npm workspaces need every package
# manifest present to build the install tree, so copy each one before `npm ci`.
COPY package.json package-lock.json ./
COPY packages/mcp-engine/package.json ./packages/mcp-engine/
COPY packages/cli/package.json ./packages/cli/
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="postgresql:///" \
    MOTHERDUCK_TOKEN="dummy"
RUN npm run build

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
