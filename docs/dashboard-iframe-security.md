# Security issue: dashboard iframe sandbox is defeated by `allow-same-origin`

Status: **FIXED 2026-07-05** (recorded same day). The iframe is now
`sandbox="allow-scripts"` (opaque origin) and its assets load without the
session cookie via option **1b** below (frame route mints a capability token for
the bundle; vendor JS is public). Verified with headless Chromium: both sample
dashboards render, and adversarial probes from inside the frame confirm the
guest can no longer read the parent DOM, `document.cookie`, or make a
credentialed same-origin `fetch` (all blocked / opaque origin). Remaining
hardening (defense-in-depth, not blocking): steps 2–4 — separate origin, origin
checks on the bridge, CSP on the frame document.

## TL;DR

Dashboard artifacts are **untrusted code** — `Dashboard.tsx` is pulled from a
GitHub repo and, by design (`repo-artifacts.md` §0, §8), the runtime sandbox is
what contains it. The sandbox is currently **not enforced**: the iframe is
served **same-origin** with `sandbox="allow-scripts allow-same-origin"`. That
combination gives the untrusted dashboard the viewer's full app-origin
authority, so a malicious or hallucinated dashboard is effectively stored XSS
against every viewer.

## The intended model (`repo-artifacts.md` §8)

Two layers:

- **Trusted shell** — the app page. Holds the viewer's session, is the single
  enforcement point, brokers governed `/api/dashboards/run` calls.
- **Untrusted artifact** — repo-authored `Dashboard.tsx`, in an
  `<iframe sandbox>` **without `allow-same-origin`**, ideally on a **separate
  origin**. No session, no cookies, no direct network. Its only channel is
  `postMessage` to the shell.

The whole safety argument ("a compromised or hallucinated artifact can't touch
data or credentials", §10) rests on the artifact having no ambient authority.

## What the code actually does

- `src/app/datasets/[id]/dashboard/[name]/page.tsx` — the iframe is
  `sandbox="allow-scripts allow-same-origin"` and its `src` is a **same-origin**
  route (`/api/dashboards/[datasetId]/[name]/frame`).
- The frame route + `frame-source.ts` run the artifact's default-export
  component inside that iframe.

`allow-same-origin` on a frame whose content is already same-origin means the
sandbox provides **no origin isolation**. The document keeps the app's real
origin, and the guest script can reach out of the booth.

### What the untrusted dashboard can do today

Because it runs on the app origin with `allow-same-origin`, the guest code can:

- `window.parent.document` — read/modify the trusted shell's DOM (it's
  same-origin), i.e. exfiltrate anything on the page or hijack the UI.
- `fetch("/api/…")` **directly**, with the viewer's session cookie, to **any**
  same-origin endpoint — `/api/me`, `/api/datasets/*`, admin routes, and other
  datasets' `/api/dashboards/run`. The `postMessage` bridge is supposed to be
  the *only* path to `run`; here it's bypassable, and the "single enforcement
  point" collapses.
- Read `localStorage` and any non-`httpOnly` cookie on the origin.

So the containment described in §8/§10 does not hold. The `run` endpoint itself
is correctly viewer-scoped (`getSessionUser` → `runDashboard(user.id, …)`), but
that's irrelevant when the guest can call the whole API surface as the viewer.

### Secondary `postMessage` weaknesses

Even with the sandbox fixed, tighten the bridge:

- `frame-source.ts` posts to the parent with `targetOrigin: "*"`
  (`parent.postMessage({type:"run",…}, "*")`), and its `message` listener checks
  `e.source === window.parent` but not `e.origin`.
- `page.tsx` posts results back with `targetOrigin: "*"` and its `onMessage`
  checks `e.source === frame.contentWindow` but not `e.origin`.

Source checks are decent, but origin checks are the belt-and-suspenders the
bridge should have, especially once the frame is on a separate origin.

## Recommendation

Fix in layers, cheapest first. **(1) is the actual fix**; the rest is
defense-in-depth the design already calls for.

### 1. Drop `allow-same-origin` — but it must ship with an asset-auth change

Change the iframe to `sandbox="allow-scripts"`. The frame document then runs in
an **opaque origin**: no access to `window.parent.document`, no app-origin
cookies, and same-origin `fetch` to `/api/*` no longer carries the session. The
guest is reduced to `postMessage` — exactly the §8 model.

**Empirical finding (2026-07-05, tested on the localhost fork with headless
Chromium):** dropping `allow-same-origin` *by itself* breaks the dashboard — it
renders nothing. The frame's own assets are same-origin **auth-gated**, and an
opaque-origin document's subresource requests are treated as cross-site, so the
`SameSite=Lax` session cookie is withheld from them:

| request | with `allow-same-origin` | with `allow-scripts` only |
| --- | --- | --- |
| `/api/dashboards/.../frame` (subframe nav) | 200 | **200** — nav still carries the cookie |
| `/dashboard-vendor.js` (proxy-gated static) | 200 | **redirected to sign-in** |
| `/api/dashboards/.../bundle` (auth-gated route) | 200 | **401** |

So the isolation and the asset delivery are coupled: to sandbox the frame you
must also make its assets loadable **without the ambient session cookie**. Pick
one:

- **1a. Inline the assets into the frame HTML.** The frame *navigation* still
  carries the cookie (it's a same-site subframe nav), so gate only that, and
  inline both the vendor JS and the compiled bundle as `<script>` in the frame
  document — zero authed subresources. Cost: the ~3.6 MB vendor bundle is
  re-sent per frame load (loses static caching) and inline scripts need CSP
  hashes / `'unsafe-inline'`.
- **1b. Token-gate the assets (IMPLEMENTED).** The **frame route** stays
  cookie-authed (the same-site subframe navigation still carries the cookie) and
  mints a short-lived signed capability token (`src/lib/dashboards/frame-token.ts`,
  HMAC over `AUTH_SECRET`, 5-min TTL, scoped to viewer + dataset + dashboard),
  embedding it in the **bundle** URL (`?t=…`). The **bundle route** validates the
  token instead of the cookie and scopes `getDashboard` to the token's viewer.
  The **vendor JS** is generic library code (no secrets, no user data), so it's
  made public via a proxy-matcher exemption rather than token-gated. The token
  grants reading this dashboard's own static assets only — never a data run
  (still brokered by the trusted parent's session) — so reading it out of the
  guest document yields no escalation. For a **separate artifact origin** later
  (step 2), the frame nav loses the cookie too, so the parent would mint/pass a
  token to the frame as well and the frame route would accept token-or-cookie —
  a small increment on this.
- **1c. Make vendor + bundle public (unauthenticated).** Simplest, but the
  bundle is the dashboard's source JS; serving it by URL with no auth leaks
  private-dataset artifact code. Only acceptable for public datasets. Weak;
  not recommended.

Other notes when making the change:
- `parent.postMessage(…, "*")` still works across the opaque-origin boundary
  (postMessage is designed to cross origins). Keep the parent's
  `e.source === frame.contentWindow` guard.
- The ~3.6 MB vendor bundle (React + ReactDOM + `@malloydata/render`) has **no**
  `localStorage`/`sessionStorage`/`document.cookie` references, so the renderer
  should not hit a `SecurityError` in an opaque origin (the other common blocker
  for this change). Confirm by driving a real render once assets load.

### 2. Serve the frame from a separate origin (defense-in-depth, `repo-artifacts.md` §9 #1)

Even sandboxed, a separate origin is stronger and unblocks any storage-needing
renderer. Custom domains under a shared parent (`app.<domain>` /
`artifacts.<domain>`); mind the `*.vercel.app` Public-Suffix cookie caveat noted
in §9 #1. With a fixed artifact origin, the parent can post results with an
explicit `targetOrigin` instead of `"*"`.

### 3. Harden the bridge

- Add `e.origin` checks on both `message` listeners (once the artifact origin is
  known/fixed).
- Keep the shell as the sole validator: honor only `{ name, givens }`, keep the
  query server-fixed by manifest, keep runs viewer-scoped.

### 4. CSP on the frame document

Send a restrictive `Content-Security-Policy` on the
`/api/dashboards/.../frame` response — e.g. `default-src 'none'`,
`script-src 'self'` (vendor + bundle), `connect-src 'none'` (no network from the
guest at all), `style-src` as the renderer needs. Caps the blast radius even if
an isolation layer regresses.

## Fix / test loop

The standing localhost env (`local/CLAUDE.md` → "Localhost dev against a fork of
the main DB") has real dashboards (e.g. `ecommerce`, `babynames`) to test the
sandbox change against — verify a dashboard still renders with
`sandbox="allow-scripts"` before shipping.
