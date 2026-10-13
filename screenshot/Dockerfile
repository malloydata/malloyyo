# Malloyyo screenshot service — see README.md. Built and published by
# .github/workflows/screenshot.yml as ghcr.io/malloydata/malloyyo-screenshot.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
# Only Chrome's headless shell (not full Chromium, Firefox or WebKit) and the
# system libraries it needs. The Playwright version pins the browser build.
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY server.mjs ./

# No secrets live here: the service holds only its own key.
USER node
EXPOSE 3100
CMD ["node", "server.mjs"]
