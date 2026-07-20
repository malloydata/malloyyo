// @ts-nocheck
// Browser entry for the IN-PAGE (no-iframe) tag-only dashboard preview. A
// dashboard with no Dashboard.tsx has no untrusted code to sandbox, so the dev
// server mounts the runtime's DefaultDashboard DIRECTLY in the trusted shell
// page — full-width, page-scrolling, like the VSCode/Composer preview. This is
// the in-page twin of frame-entry.tsx (the sandboxed iframe entry for CUSTOM
// dashboards): same runtime, but a direct-fetch host instead of postMessage.
import { mountInPage } from "./frame-runtime/index";

const info = window.__DASHBOARD__ || {};
const name = info.name;

// Reflect committed givens into the shell URL as `?d=<name>&$NAME=…`.
const givensToUrl = (dashboard, givens) => {
  const u = new URL(location.href);
  u.search = "";
  u.searchParams.set("d", dashboard);
  for (const [k, v] of Object.entries(givens)) if (v != null && String(v) !== "") u.searchParams.set("$" + k, String(v));
  return u.pathname + u.search;
};

mountInPage({
  root: document.getElementById("root"),
  // Governed query — the shell's trusted /api/run (the same endpoint the iframe
  // broker forwards to). Returns the raw result the runtime normalizes.
  run: (req, givens) =>
    fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ d: name, query: req.query, malloy: req.malloy, givens }),
    })
      .then((r) => r.json())
      .catch((e) => ({ ok: false, problems: [{ message: String(e) }] })),
  navigate: (dashboard, givens) => {
    location.href = givensToUrl(dashboard, givens);
  },
  syncGivens: (givens) => history.replaceState(null, "", givensToUrl(name, givens)),
});
