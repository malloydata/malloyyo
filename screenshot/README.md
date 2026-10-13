# Malloyyo screenshot service

A headless browser that renders a Malloyyo dashboard as a PNG, so Claude can
look at a dashboard (often a draft it just saved) before showing it to anyone.
It powers the `screenshot_dashboard` MCP tool.

It runs **apart from the app**, as its own container, and knows almost
nothing: it is configured with one app origin, and each request carries only a
short-lived token. The app decides what that token may show.

```
Claude ──screenshot_dashboard──▶ app ──POST /render {token}──▶ this service
                                   ▲                                │
                                   └── GET /screenshot (token) ◀────┘
                                       + the dashboard's own routes
```

1. The app checks the caller can see the dashboard and mints a token for
   **that user, that dashboard, those filter values**, valid for 90 seconds
   (`src/lib/dashboards/screenshot-token.ts`).
2. This service opens `${APP_ORIGIN}/screenshot`, sending the token as the
   `x-malloyyo-screenshot` header. The page renders the dashboard with the same
   renderers and routes a person would get. Those routes accept the token for
   that one dashboard and nothing else (`src/lib/dashboards/viewer.ts`).
3. It waits until the page is idle, grows any dashboard iframe to its content,
   and returns the PNG and what the page reported: tile errors the renderer
   drew, console and page errors, failed requests, and anything it refused.

## Run it

```bash
docker run -d -p 3100:3100 \
  -e APP_ORIGIN=https://malloyyo.example.com \
  -e SCREENSHOT_SERVICE_KEY="$(openssl rand -hex 24)" \
  ghcr.io/malloydata/malloyyo-screenshot:latest
```

Then give the app the same key and the service's address:

```bash
SCREENSHOT_SERVICE_URL=http://screenshot:3100
SCREENSHOT_SERVICE_KEY=<the same key>
```

With no `SCREENSHOT_SERVICE_URL`, the app never registers the tool.

Next to a self-hosted app (`docker compose`):

```yaml
services:
  app:
    image: malloyyo
    environment:
      SCREENSHOT_SERVICE_URL: http://screenshot:3100
      SCREENSHOT_SERVICE_KEY: ${SCREENSHOT_SERVICE_KEY}
      # …the app's usual settings
  screenshot:
    image: ghcr.io/malloydata/malloyyo-screenshot:latest
    environment:
      APP_ORIGIN: http://app:3000
      SCREENSHOT_SERVICE_KEY: ${SCREENSHOT_SERVICE_KEY}
```

An instance on Vercel can't host it, since a function has no room or time for a
browser. Run the container somewhere the instance can call (Cloud Run, Fly, a
VM) with `APP_ORIGIN` set to the instance's public URL.

| Variable | Default | |
|---|---|---|
| `APP_ORIGIN` | — (required) | The one origin it renders, e.g. `https://malloyyo.example.com`. |
| `SCREENSHOT_SERVICE_KEY` | — (required, 16+ chars) | Bearer key the app must send. |
| `PORT` | `3100` | |
| `MAX_CONCURRENT` / `MAX_QUEUED` | `2` / `8` | Renders at once, and waiting before `429`. |
| `RENDER_TIMEOUT_MS` | `30000` | Per render; a page still busy then is captured anyway and reported `timedOut`. |
| `SETTLE_MS` | `750` | Pause after the page goes idle, for charts to finish drawing. |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` / `MAX_HEIGHT` | `1280` / `1000` / `6000` | Full-page captures are cut at `MAX_HEIGHT`. |
| `CHROMIUM_SANDBOX` | `auto` | `1` requires Chrome's sandbox, `0` disables it, `auto` tries it and falls back. `/healthz` reports which. |

`GET /healthz` answers `{"ok":true,"browser":true,"sandboxed":…}`.

## Security model

The page runs dashboard code that members wrote. Treat it as untrusted, and
let these layers carry the weight:

- **Nothing to steal.** The container holds only its own key: no database URL
  and no app secrets.
- **Its network should reach only the app.** Inside the browser, every request
  and WebSocket to another origin is refused and reported, and the token rides
  only on the page's own requests and navigations, never on a fetch made by
  dashboard code inside its sandboxed iframe. Back that up outside the browser
  wherever you can: a compose network with no other route, platform egress
  rules, or a firewall. The cloud metadata address (`169.254.169.254`) matters
  most.
- **The token is the whole grant.** It's the requesting user's own identity,
  limited to one dashboard and 90 seconds, and every query still goes through
  the restricted-query rules. A leaked token can do no more than that user
  opening that dashboard for that minute and a half.
- **Chrome's sandbox.** Docker's default seccomp profile blocks it, so with the
  defaults the service runs Chrome without it (and `/healthz` says
  `"sandboxed": false`). Then the container boundary is what contains a browser
  exploit, which is why it must hold nothing worth taking. `--cap-add=SYS_ADMIN`
  lets the sandbox start (verified), at the cost of a broader capability for the
  container. Pick one deliberately.

`npm test` runs the lockdown end to end: the real service against a fixture app
whose page tries to reach other hosts, the metadata address, and an outside
WebSocket, and whose sandboxed iframe makes its own requests.

## Known limits

- **Fonts are Linux's.** The picture shows what Chrome on Linux draws, so a
  label that truncates on a Mac may fit here, and the reverse.
- **Plain-HTTP origins.** On `http://` with a name other than `localhost`
  (`http://app:3000` in compose), the page isn't a secure context, and the
  Malloy renderer's charts call `crypto.randomUUID`, which only exists in one.
  The service supplies that one function for such origins. Chrome's
  `--unsafely-treat-insecure-origin-as-secure` would be the general fix, but
  the headless shell ignores it.
- **Image size.** About 1.2 GB unpacked: Chrome's headless shell (~270 MB),
  the system libraries it needs, and fonts.

## Developing it

```bash
cd screenshot
npm install
npx playwright install --only-shell chromium
npm test

# against `npm run dev` on the host
APP_ORIGIN=http://localhost:3000 SCREENSHOT_SERVICE_KEY=dev-key-0123456789 npm start
```

From a container, reach a host dev server as `http://host.docker.internal:3000`.
The app's `next.config.ts` allows that origin in dev.
