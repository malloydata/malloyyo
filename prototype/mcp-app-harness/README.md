# MCP Apps harness (prototype)

Exercises `src/lib/mcp-app.ts` without deploying or connecting a client. It
stands in for the part of an MCP Apps host that can actually break: the app runs
in a sandboxed iframe **without** `allow-same-origin`, so it gets an opaque
origin the way a real host gives it, and the handshake is JSON-RPC over
`postMessage` — `ui/initialize` in, `ui/notifications/size-changed` back.

```bash
npm i playwright                # once, in this directory
npx tsx gen.ts .                # writes app.html + tool-result.json
node host.mjs                   # serves the host page on :4181
CHROMIUM_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())") \
  node shot.mjs out.png
```

A pass is `host events: ui/initialize | size-changed …` and a panel reading
`handshake: ok`. `handshake: pending` means the resource rendered but the host
never answered — which is the interesting failure, because it is the one a real
host would also show.
