// @ts-nocheck
// Browser entry for a STATIC dashboard site (`malloyyo dashboard bundle`).
//
// The other two entries assume a server holds the privileged capability:
// frame-entry.tsx postMessages a trusted parent, frame-inpage-entry.tsx fetches
// /api/run. This one has no server at all. Malloy compiles in the page and
// DuckDB-WASM executes the SQL, so `host.run` is a local function call.
//
// That also means there is nothing to sandbox: with no credential in the page,
// the iframe bought isolation from a threat that no longer exists, so custom and
// tag-only dashboards share a single in-page mount (mountStatic).
// Exported as boot(Dashboard) rather than self-executing: `dashboard bundle`
// generates one tiny entry per dashboard that imports its own component and
// calls this, so a single build can emit N dashboards that share one chunk.
import * as duckdb from "@duckdb/duckdb-wasm";
import { DuckDBWASMConnection } from "@malloydata/db-duckdb/wasm";
import { API, SingleConnectionRuntime } from "@malloydata/malloy";
import { mountStatic } from "./frame-runtime/index";
import { givensFromSearch, givensToParams } from "./shared/givens-url";

const info = window.__DASHBOARD__ || {};
const MODEL_FILES = window.__MODEL_FILES__ || {};
const ENTRY = `file:///${info.entryFile}`;

// ── DuckDB-WASM ─────────────────────────────────────────────────────

// Bundle URLs MUST be absolute. selectBundle hands them to the WORKER, whose
// base URL is the worker's own directory — a relative path resolves against
// that, 404s, and instantiate() then hangs forever with no error. This bites
// hardest on GitHub Pages, where the site is served from /<repo>/.
const abs = (p: string) => new URL(p, document.baseURI).href;

// Where the DuckDB binaries come from. The build sets __DUCKDB_BASE__ when it
// self-hosts them; absent, we use duckdb-wasm's own jsDelivr helper, which pins
// the exact installed version in an immutable, CORS-open URL.
const DUCKDB_BASE: string | undefined = (window as any).__DUCKDB_BASE__;

class StaticWasmConnection extends DuckDBWASMConnection {
  getBundles() {
    if (!DUCKDB_BASE) return duckdb.getJsDelivrBundles();
    const at = (f: string) => abs(DUCKDB_BASE + f);
    return {
      mvp: { mainModule: at("duckdb-mvp.wasm"), mainWorker: at("duckdb-browser-mvp.worker.js") },
      eh: { mainModule: at("duckdb-eh.wasm"), mainWorker: at("duckdb-browser-eh.worker.js") },
    };
  }
}

// Whole-file fetch, not ranged reads.
//
// __TABLE_FILES__ maps each table reference the model makes to the URL this
// page fetches for it. The KEY is what the model wrote and what DuckDB will
// look up, so registering the bytes under that exact name means the model needs
// no rewriting between `dashboard dev` (reads the file off disk) and here.
//
// Project-relative refs like `data/x.parquet` resolve against the page, so they
// are SAME-ORIGIN — no CORS involved at all. Absolute URLs are fetched
// cross-origin and do need CORS on that host.
//
// This cannot go through db-duckdb's registerRemoteTableCallback: findTables
// skips anything matching ^https?:// ("handled by duckdb-wasm"), so the callback
// never fires for a remote URL. Pre-registering is also strictly better — one
// bulk GET instead of dozens of ranged round trips.
const TABLE_FILES: Record<string, string> = (window as any).__TABLE_FILES__ || {};

async function preloadTables(db: any) {
  await Promise.all(
    Object.entries(TABLE_FILES).map(async ([name, href]) => {
      const url = new URL(href, document.baseURI).href;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status} ${r.statusText}`);
      await db.registerFileBuffer(name, new Uint8Array(await r.arrayBuffer()));
    }),
  );
}

// ── Malloy ──────────────────────────────────────────────────────────

// Model sources are inlined at build time (model-files.js) and keyed by the
// file:// URL Malloy resolves imports against, so nothing is fetched at runtime.
const urlReader = {
  readURL: async (url: URL | string) => {
    const key = url.toString();
    const src = MODEL_FILES[key];
    if (src == null) {
      throw new Error(`model file not found: ${key}\nhave: ${Object.keys(MODEL_FILES).join(", ")}`);
    }
    return src;
  },
};

let runtimeP: Promise<unknown> | null = null;
function getRuntime() {
  if (!runtimeP) {
    runtimeP = (async () => {
      const connection = new StaticWasmConnection({ name: "duckdb" });
      await connection.connecting;
      await preloadTables((connection as any).database);
      return new SingleConnectionRuntime({ connection, urlReader });
    })();
  }
  return runtimeP;
}

// Panel/data query text may arrive with or without a leading `run:`.
const asRun = (t: string) => (/^\s*run\s*:/.test(t) ? t : `run: ${t}`);

// Match `dashboard dev` exactly (host.ts passes this on every run path). Without
// an explicit limit Malloy applies its own much smaller default, which silently
// truncates tiles rather than erroring — they just look half-empty.
const ROW_LIMIT = 5000;

/** The host contract, served locally. `query` names a model-published query (or
    a `source -> view` path); `malloy` is query text the runtime builds itself
    (the given typeahead). Shape matches the dev server's: {ok, rows,
    stable_result, problems[]}. */
async function run(req: { query?: string; malloy?: string }, givens: Record<string, unknown>) {
  try {
    const runtime: any = await getRuntime();
    const model = runtime.loadModel(new URL(ENTRY));
    const text = req.malloy != null ? asRun(req.malloy) : asRun(req.query as string);
    const result = await model.loadQuery(text).run({ rowLimit: ROW_LIMIT, givens: givens ?? {} });
    // Same shaping the engine does (mcp-engine/src/run.ts): plain rows for
    // components that draw themselves, plus the interfaces-format result the
    // Malloy renderer needs for DefaultDashboard / <Panel>.
    return {
      ok: true,
      rows: result.toJSON().queryResult.result,
      stable_result: API.util.wrapResult(result),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, problems: [{ message: msg }] };
  }
}

// ── mount ───────────────────────────────────────────────────────────

// Same param encoding as the dev server (shared/givens-url); only the path
// shape differs — sibling .html pages here vs `/?d=` there.
const givensToUrl = (dashboard: string, givens: Record<string, unknown>) => {
  const u = new URL(`./${dashboard}.html`, document.baseURI);
  u.search = givensToParams(givens).toString();
  return u.pathname + u.search;
};

// Custom dashboards drive drills by posting to `parent` directly:
//   parent.postMessage({ type: "navigate", dashboard, givens }, "*")
// Under `dashboard dev` the component runs in a sandboxed iframe, so `parent`
// is the trusted shell, which listens and navigates. Here there IS no iframe —
// the dashboard owns the top window — so `parent === window` and those messages
// are posted to ourselves with nobody listening: clicking a name silently did
// nothing. Re-implement the shell's half of the protocol against our own window.
function installMessageBridge(name: string) {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return; // no other frames exist; ignore anything else
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "givens" && m.givens) {
      history.replaceState(null, "", givensToUrl(name, m.givens));
      return;
    }
    if (m.type === "navigate" && typeof m.dashboard === "string") {
      location.href = givensToUrl(m.dashboard, m.givens || {});
    }
  });
}

/** Mount this page's dashboard. `Dashboard` is the model repo's own component,
    or null for a tag-only dashboard (mountStatic falls back to the renderer). */
export function boot(Dashboard: unknown) {
  // Seed shareable-link values the same way the dev server does — server-side
  // there, here from our own query string, but through the SAME encoder, so the
  // `$` prefix the runtime keys off is preserved. Set before mount: the runtime
  // reads this global lazily when it computes initial given values.
  (window as any).__INITIAL_GIVENS__ = givensFromSearch(location.search);
  installMessageBridge(info.name);
  return mountStatic(Dashboard, {
    root: document.getElementById("root") as HTMLElement,
    run,
    navigate: (dashboard, givens) => {
      location.href = givensToUrl(dashboard, givens);
    },
    syncGivens: (givens) => history.replaceState(null, "", givensToUrl(info.name, givens)),
  });
}
