// @ts-nocheck
// The dashboard frame runtime — the ONE implementation shared by the CLI dev
// preview (bundled from source by dashboard.ts) and the hosted app (bundled
// into public/dashboard-vendor.js at build time as window.__DASH_RUNTIME__).
//
// It runs inside the sandboxed iframe: no credentials, no network — its only
// channel is postMessage to the trusted parent, which runs queries server-side
// (named queries from the model's published surface, or restricted Malloy text)
// and posts results back.
//
// Injected frame globals (read lazily — script order differs between hosts):
//   window.__DASHBOARD__      { name, query, title, description? }  (the # artifact tag)
//   window.__GIVENS__         given specs introspected from the model's given: decls
//   window.__INITIAL_GIVENS__ URL-seeded given values for shareable links
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { MalloyRenderer } from "@malloydata/render";
import { filters } from "./filters";
// The drill contract (which cells drill, to where, seeding which given) is shared
// with the hosted app's ltool result view — see drill.ts.
import { drillFieldNames, humanizeSlug, markDrillableCells, resolveDrill } from "./drill";
import { combineTiles } from "./combine";

export { filters };

export const dashboardInfo = () => window.__DASHBOARD__ || {};
export const givenSpecs = () => window.__GIVENS__ || [];

// ── bridge to the trusted parent ────────────────────────────────────
let seq = 0;
const pending = new Map();
if (typeof window !== "undefined") {
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return; // only the trusted shell
    const m = e.data;
    if (m && m.type === "result" && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
}

// req: { query } (a named query the model publishes) or { malloy } (restricted
// Malloy text — the server's restricted mode is the gate). A composite dashboard
// runs one { query } per tile and combines the results client-side (see
// CompositeDashboard), so there's no single "run the whole dashboard" request.
// The result shape is normalized across hosts (dev server: {stable_result,
// problems[]}; hosted: {stableResult, error}).
export function runQuery(req, givens) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    parent.postMessage({ type: "run", id, query: req.query, malloy: req.malloy, givens }, "*");
  }).then((m) => ({
    ok: !!m.ok,
    rows: m.rows || [],
    result: m.stable_result ?? m.stableResult,
    error: m.ok
      ? undefined
      : String(m.error ?? (m.problems || []).map((p) => p.message).join("; ") ?? "query failed"),
  }));
}

// Panel/data query text may come with or without a leading `run:`.
export const asRunText = (text) => (/^\s*run\s*:/.test(text) ? text : `run: ${text}`);

/** Run restricted Malloy text, resolve to the result rows (array of objects). */
export function runData(malloy, givens) {
  return runQuery({ malloy: asRunText(malloy) }, givens ?? {}).then((m) => {
    if (!m.ok) throw new Error(m.error);
    return m.rows;
  });
}

// ── givens state (context) ──────────────────────────────────────────
const Ctx = createContext(null);

export function useDashboard() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("dashboard hooks must run inside the dashboard runtime");
  return ctx;
}

/** One given's value + setter + declaration spec: const state = useGiven("STATE").
    `value` is the DRAFT value the control is editing — in the live (autorun)
    default draft === committed, so a control change re-runs immediately; under
    `autorun=false` the draft accumulates until Controls' Apply commits it. */
export function useGiven(name) {
  const { draft, setGiven } = useDashboard();
  const spec = useMemo(() => givenSpecs().find((s) => s.name === name), [name]);
  return {
    value: draft[name],
    set: useCallback((v) => setGiven(name, v), [name, setGiven]),
    spec,
  };
}

// ── queries as hooks ────────────────────────────────────────────────
/** Run a query and get plain data back: { rows, result, loading, error }.
    req: { query?: string, malloy?: string, givens?: object }. For charting
    with your own components — Panel is the same thing plus Malloy's renderer. */
export function useQuery(req) {
  const wire = req.malloy ? { malloy: asRunText(req.malloy) } : { query: req.query };
  const skip = !!req.skip; // a Panel handed a pre-run result fetches nothing
  const givens = req.givens ?? {};
  const key = JSON.stringify([wire, givens, skip]);
  const [state, setState] = useState({ rows: [], loading: !skip });
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    runQuery(wire, givens).then((m) => {
      if (cancelled) return;
      if (m.ok) setState({ rows: m.rows, result: m.result, loading: false });
      else setState({ rows: [], loading: false, error: m.error });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state;
}

// ── suggestions / typeahead ─────────────────────────────────────────
// A given's options come from its structured `# suggest { … }` tag, which the
// engine surfaces as spec.suggest:
//   { source, dimension }   — distinct values of a dimension:  run: <source> -> <field>
//   { query [, dimension] } — a named query's first column:    run: <query>
// When the dimension is known, typed text refines the base server-side:
//   <base> + { where: lower(<field>) ~ f'<typed>%'; limit: 50 }
// (case-insensitive prefix; the typed text is escaped through the filter
// serializer so `%`/`,`/quotes can't break out). Without a dimension the
// runtime prefix-filters the fetched list client-side.
const TYPEAHEAD_LIMIT = 50;
const optionCache = new Map();

function firstColumn(rows) {
  return rows.map((r) => Object.values(r)[0]).filter((v) => v != null);
}

const quoteField = (f) => (/^[A-Za-z_]\w*$/.test(f) ? f : `\`${f}\``);

function suggestBase(s) {
  if (s.query) return `run: ${s.query}`;
  if (s.source && s.dimension) return `run: ${s.source} -> ${quoteField(s.dimension)}`;
  return null;
}

function typeaheadText(s, typed) {
  const filterSrc = filters.startsWith(typed.toLowerCase()).replace(/'/g, "\\'");
  return `${suggestBase(s)} + { where: lower(${quoteField(s.dimension)}) ~ f'${filterSrc}'; limit: ${TYPEAHEAD_LIMIT} }`;
}

/** Options for a control, from the given's `# suggest {…}` tag. Pass the text
    the user has typed so far for typeahead: { options, loading }. */
export function useOptions(name, typed) {
  // Narrow suggestions against the DRAFT filters the user is composing, so a
  // related-filter suggest query (e.g. brand narrowed by category) tracks
  // edits even before Apply under autorun=false.
  const { draft: givens } = useDashboard();
  const spec = givenSpecs().find((s) => s.name === name);
  const suggest = spec && spec.suggest;
  const base = suggest ? suggestBase(suggest) : null;
  const term = (typed ?? "").trim();
  // RELATED FILTERS: suggestion queries run with the dashboard's CURRENT given
  // values, so a suggest query that references other givens (e.g. brand_suggest
  // with `where: product_category ~ $CATEGORY`) narrows as the user filters.
  // The suggested given itself is excluded — its current value is what the
  // user is replacing; self-filtering would collapse the list to the current
  // pick. Which givens apply (if any) stays declared in the model's query.
  const others = {};
  for (const k of Object.keys(givens)) if (k !== name) others[k] = givens[k];
  const othersKey = JSON.stringify(others);
  const [state, setState] = useState({ options: [], loading: !!base });
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    // With a known dimension the typed term refines server-side; otherwise the
    // full base list is fetched once (per given values) and filtered client-side.
    const serverSide = !!suggest.dimension;
    const key = `${name}\0${serverSide ? term.toLowerCase() : ""}\0${othersKey}`;
    const hit = optionCache.get(key);
    if (hit) {
      setState({ options: clientFilter(hit, serverSide, term), loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    // Debounce keystrokes; the empty-term (full list) fetch runs immediately.
    const timer = setTimeout(
      () => {
        const q = term && serverSide ? typeaheadText(suggest, term) : base;
        runData(q, JSON.parse(othersKey))
          .then((rows) => {
            const options = firstColumn(rows);
            optionCache.set(key, options);
            if (!cancelled)
              setState({ options: clientFilter(options, serverSide, term), loading: false });
          })
          .catch(() => {
            if (!cancelled) setState({ options: [], loading: false });
          });
      },
      term && serverSide ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, base, term, othersKey]);
  return state;
}

// Query-form suggests without a dimension can't be refined server-side (the
// runtime doesn't know the output column) — prefix-filter the fetched list.
function clientFilter(options, serverSide, term) {
  if (!term || serverSide) return options;
  const lower = term.toLowerCase();
  return options.filter((o) => String(o).toLowerCase().startsWith(lower)).slice(0, TYPEAHEAD_LIMIT);
}

// ── Panel: run a query, render with Malloy's renderer ───────────────
// Inputs (pick one): `query` (a model query name or `source -> view`), `malloy`
// (restricted text), `dashboard` (run the current composite artifact's tiles),
// or a pre-run `result` (render it as-is, fetch nothing — the composite simple
// path hands the combined result straight in).
export function Panel({ query, malloy, dashboard, result: presetResult, givens, style }) {
  // Input precedence: explicit malloy / dashboard / query prop wins. A BARE
  // <Panel/> (no input) renders "this dashboard": for a composite (tiles) that's
  // the whole thing (dashboard mode); for a single-query artifact it's that
  // query. In v1 a bare Panel meant `dashboardInfo().query`; v2 dashboards carry
  // `tiles` and an empty query, so a bare Panel in a hand-written component must
  // fall through to dashboard mode rather than run an empty query.
  const info = dashboardInfo();
  // A COMPOSITE dashboard (tiles) is rendered by CompositeDashboard, which runs
  // its tiles and combines them into one Malloy-rendered `# dashboard`. A bare
  // <Panel/> or an explicit <Panel dashboard/> on a composite delegates here; an
  // explicit query / malloy / preset does not. `info.tiles`/`isComposite` are
  // stable for a given call site, so this early return never changes the hook
  // count across renders.
  const isComposite = !query && !malloy && presetResult === undefined && (dashboard || info.tiles);
  if (isComposite && info.tiles) {
    return <CompositeDashboard givens={givens} style={style} />;
  }
  // Past the composite early-return this is always a single query: an explicit
  // malloy / query prop, else the artifact's own query.
  const req = malloy ? { malloy } : query ? { query } : { query: info.query };
  const hasPreset = presetResult !== undefined;
  const live = useQuery(hasPreset ? { skip: true } : { ...req, givens });
  const result = hasPreset ? presetResult : live.result;
  const loading = hasPreset ? false : live.loading;
  const error = hasPreset ? undefined : live.error;
  const ref = useRef(null);
  // Drill: a dimension declared `# drill { to=[<slug>|self, …] }` makes clicking
  // its cell navigate to another dashboard (slug) and/or filter in place (self),
  // seeding the given named like the dimension, upcased (category → CATEGORY).
  const { setGiven } = useDashboard();
  const setGivenRef = useRef(setGiven);
  setGivenRef.current = setGiven;
  const [menu, setMenu] = useState(null); // { x, y, items:[{label, run}] } | null
  const drillNamesRef = useRef(new Set()); // drillable field names for the current result
  const observerRef = useRef(null);
  const onCellClick = useCallback((payload) => {
    const drill = resolveDrill(payload);
    if (!drill) return;
    const { dests, given, filterExpr } = drill;
    // `self` needs a matching given on THIS dashboard to filter in place (case-insensitive).
    const selfSpec = givenSpecs().find((s) => s.name.toUpperCase() === given.toUpperCase());
    const run = (dest) => {
      if (dest === "self") {
        if (selfSpec) setGivenRef.current(selfSpec.name, filterExpr);
      } else {
        parent.postMessage({ type: "navigate", dashboard: dest, givens: { [given]: filterExpr } }, "*");
      }
    };
    const valid = dests.filter((d) => d !== "self" || selfSpec);
    if (!valid.length) return;
    if (valid.length === 1) return run(valid[0]);
    const items = valid.map((d) => ({
      label: d === "self" ? "Filter this dashboard" : humanizeSlug(d),
      run: () => run(d),
    }));
    const ev = payload.event || {};
    setMenu({ x: ev.clientX || 0, y: ev.clientY || 0, items });
  }, []);
  // Keep ONE renderer/viz alive for the Panel's lifetime and update it in place
  // (setResult + render) on each new result. Rebuilding the MalloyRenderer per
  // result — the old approach — cold-re-inits plugins/metadata/chart workers and
  // remove()s the previous render, so the whole panel blanks and flashes on every
  // control change. render() disposes only the prior render, not the renderer.
  const vizRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !result) return;
    const container = ref.current;
    try {
      if (!vizRef.current) {
        const renderer = new MalloyRenderer({});
        // Virtualization OFF, and no scrollEl. The renderer's virtualizers
        // only work when they own the scroll container; here the Panel is the
        // scroller. scrollEl binds EVERY virtualizer in the result (each
        // nested `# dashboard` table gets one) to that single element and
        // they fight over its offset; without scrollEl they unmount whatever
        // "scrolled away" from their frozen offset 0 and the content
        // collapses. Either way the panel snaps to 0 while the user scrolls —
        // the "screen jumps around" bug. Static rendering is fine at the
        // dashboard row cap (5000).
        vizRef.current = renderer.createViz({
          // rowLimit caps how many rows any table (incl. dashboard cards) builds
          // into the DOM. Without it, an unbounded card table (e.g. group_by user)
          // renders every row as static DOM (virtualization is off) and crashes
          // the tab. The renderer truncates data() at rowLimit and shows a
          // "Limiting … to N records" footer — so a huge table degrades to
          // "top N + too many rows" instead of blowing up. Dashboard cards get
          // this via the tableConfig fallback (they pass no rowLimit of their own).
          tableConfig: { enableDrill: false, disableVirtualization: true, rowLimit: 1000 },
          dashboardConfig: { disableVirtualization: true },
          // Drill: clicking a `# drill`-tagged dimension navigates / filters in
          // place (no-op for cells without the tag).
          onClick: onCellClick,
        });
      }
      vizRef.current.setResult(result);
      vizRef.current.render(container);
      // Flag drillable cells so they read as links (see .dash-drill in THEME_CSS).
      // `# dashboard` cards render progressively, so a one-shot mark right after
      // render() misses tables that appear a frame later — re-mark on DOM changes.
      drillNamesRef.current = drillFieldNames(vizRef.current);
      markDrillableCells(container, drillNamesRef.current);
      if (!observerRef.current && typeof MutationObserver !== "undefined") {
        let raf = 0;
        observerRef.current = new MutationObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => markDrillableCells(container, drillNamesRef.current));
        });
        observerRef.current.observe(container, { childList: true, subtree: true });
      }
    } catch (err) {
      // Drop the viz so the next good result rebuilds cleanly from scratch.
      try {
        vizRef.current && vizRef.current.remove();
      } catch {
        /* ignore */
      }
      vizRef.current = null;
      container.innerHTML = "";
      const pre = document.createElement("pre");
      pre.style.cssText = "color:crimson;white-space:pre-wrap;font:12px ui-monospace,monospace";
      pre.textContent = "Malloy render error:\n" + ((err && err.stack) || String(err));
      container.appendChild(pre);
    }
  }, [result]);
  // Dispose the viz only when the Panel unmounts.
  useEffect(
    () => () => {
      try {
        observerRef.current && observerRef.current.disconnect();
        vizRef.current && vizRef.current.remove();
      } catch {
        /* ignore */
      }
      observerRef.current = null;
      vizRef.current = null;
    },
    [],
  );
  if (error) return <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre>;
  // display:grid + width:100% + a real min-height: the Malloy render web
  // component has no intrinsic height for charts/maps, so it collapses in a
  // plain block container.
  //
  // maxHeight caps the panel at the frame viewport so the container is the
  // element that ACTUALLY scrolls. The renderer's virtualizer is bound to it
  // via scrollEl; if the page scrolled instead, the virtualizer would fight
  // the user (it keeps restoring its own offset → the "screen jumps around"
  // bug with `# dashboard` results). Override via the style prop only with a
  // layout that keeps the panel itself scrollable (e.g. flex:1 + minHeight:0
  // in a 100vh column, as DefaultDashboard does).
  return (
    <>
      <div
        ref={ref}
        style={{
          display: "grid",
          width: "100%",
          minHeight: 480,
          maxHeight: "100vh",
          overflow: "auto",
          // Trap the Malloy renderer's own z-indexes (its sticky dashboard-row
          // header is position:sticky z-index:200). Without an isolate here the
          // Panel is position:static, so that 200 escapes into the ROOT stacking
          // context and paints OVER a control's open dropdown. isolate makes the
          // Panel a stacking context so its internals stay below the filter bar.
          isolation: "isolate",
          // A light results surface in both light/dark shells — the Malloy renderer
          // has no dark theme, so it always draws on a legible card.
          background: "var(--dash-panel-bg, #fff)",
          color: "#171717",
          border: "1px solid var(--dash-border, #e5e7eb)",
          borderRadius: "var(--dash-radius, 8px)",
          opacity: loading ? 0.4 : 1,
          transition: "opacity .15s",
          ...style,
        }}
      />
      {menu && <DrillMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

// ── composite dashboards ────────────────────────────────────────────
// A composite artifact (`# artifact { tiles=[…] }`) runs each tile as its own
// query and combines the results into ONE `# dashboard` result that Malloy's own
// dashboard renderer lays out (colspan / break / card heights, and single-row
// aggregate tiles merged as top-level KPIs — see combine.ts). Tiles fetch in
// parallel; the dashboard paints once they've all settled, with a single early
// paint if one tile straggles (see below) so a slow tile can't block the rest.
//
// The host injects `dashboardInfo().tileSpecs` = [{ run, name, givens:[names] }]
// so each tile runs with ONLY the givens it references (binding a given a tile
// doesn't reference fails the compile). Falls back to the raw `tiles` string
// array (all givens) when the host didn't provide specs.
function tileSpecs() {
  const info = dashboardInfo();
  if (Array.isArray(info.tileSpecs) && info.tileSpecs.length) return info.tileSpecs;
  return (info.tiles || []).map((run) => ({ run, name: undefined, givens: null }));
}

// The controls hold the UNION of givens; a tile gets only the ones it declares.
// `names === null` (fallback, no per-tile info) → pass everything through.
function pickGivens(givens, names) {
  if (!names) return givens;
  const out = {};
  for (const n of names) if (n in (givens || {})) out[n] = givens[n];
  return out;
}

// Card name for a tile: its declared name, else the view name from the
// run-expression (`source -> view` → view).
function tileName(spec) {
  if (spec.name) return spec.name;
  const run = String(spec.run || "");
  const arrow = run.lastIndexOf("->");
  return (arrow >= 0 ? run.slice(arrow + 2) : run).trim();
}

// How long to batch tile data before (re)drawing. Each draw re-renders the whole
// Malloy dashboard, so coalescing arrivals into ~1 draw per interval keeps the
// fill smooth instead of flickering once per tile. This also gates the FIRST
// draw: nothing paints until this window elapses OR every tile has settled —
// a warm load (all tiles fast) paints exactly once, with full data, never
// flashing the empty skeleton. Overridable live with `?redraw=<ms>`.
const DEFAULT_REDRAW_MS = 1500;
function redrawMs() {
  if (typeof window === "undefined") return DEFAULT_REDRAW_MS;
  const v = Number(new URLSearchParams(window.location.search).get("redraw"));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_REDRAW_MS;
}

export function CompositeDashboard({ givens, style }) {
  const specs = tileSpecs();
  const columns = dashboardInfo().dashboard_columns;
  const gkey = JSON.stringify(givens ?? {});
  // Schema-up-front. Each tile ships a schema-only result (`t.schema`, compiled
  // with no data), so the WHOLE layout renders on the first paint with every card
  // in its reserved slot; each tile's real result then splices into its slot as it
  // arrives. Every tile's fields are identical whether we have its schema or its
  // full result, so the dashboard STRUCTURE never changes — only data fills in.
  // Data is accumulated in a ref and painted in BATCHES (see redrawMs). Crucially,
  // the composited result is (re)built ONLY at paint time and held in state, so its
  // object identity is stable between paints — Panel re-renders its Malloy viz only
  // when `combined` actually changes (once per batch), never on an incidental
  // re-render (a tile failing, a re-mount). That's what keeps the fill from
  // flashing as elements insert: one atomic redraw per batch, with every tile in
  // hand inserted together.
  const dataRef = useRef({}); // run-expr -> full result; accumulates without re-rendering
  const [combined, setCombined] = useState(null); // composited result; set ONLY at paint time
  const [failed, setFailed] = useState([]); // { name, message } per failed tile

  useEffect(() => {
    let cancelled = false;
    dataRef.current = {};
    setFailed([]);
    setCombined(null);
    let settled = 0;
    let firstDone = false; // has the held first paint happened yet?
    let flushTimer = null; // a batch repaint is pending while non-null
    // Build the composited result from whatever data is in hand and hand it to the
    // renderer as ONE new object — every arrived tile inserted together.
    const paint = () => {
      if (cancelled) return;
      flushTimer = null;
      firstDone = true;
      const data = dataRef.current;
      const usable = specs.filter((t) => data[t.run] || t.schema);
      setCombined(
        usable.length
          ? combineTiles(
              usable.map((t) => ({ name: tileName(t), result: data[t.run] ?? t.schema })),
              { columns },
            )
          : null,
      );
    };
    const scheduleBatch = () => {
      if (flushTimer) return; // a paint is already pending; this arrival rides it
      flushTimer = setTimeout(paint, redrawMs());
    };
    // Hold the FIRST paint until 1500ms or all tiles settle — don't flash the
    // empty skeleton. A warm load (all tiles arrive fast) then paints exactly
    // once, with full data; a slow load reveals the skeleton at 1500ms and fills
    // in subsequent batches.
    scheduleBatch();
    for (const t of specs) {
      runQuery({ query: t.run }, pickGivens(givens, t.givens)).then((m) => {
        if (cancelled) return;
        if (m.ok && m.result) {
          dataRef.current[t.run] = m.result;
          if (firstDone) scheduleBatch(); // after the first paint, batch later arrivals
        } else {
          setFailed((prev) => [...prev, { name: tileName(t), message: m.error || "query failed" }]);
        }
        settled++;
        // Everything has settled → paint now rather than waiting out the timer, so a
        // warm load doesn't sit on a stale batch (and never over-draws).
        if (settled >= specs.length) {
          if (flushTimer) clearTimeout(flushTimer);
          paint();
        }
      });
    }
    return () => {
      cancelled = true;
      if (flushTimer) clearTimeout(flushTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gkey]);

  // Tiles still awaiting data (for the progress affordance). Read from the ref at
  // render time; the bar advances on the next paint.
  const data = dataRef.current;
  const pending = specs.filter((t) => !data[t.run] && !failed.some((f) => f.name === tileName(t)));

  if (!combined) {
    // Held first paint (nothing revealed yet), no schemas + nothing arrived, or
    // every tile failed.
    if (specs.length > 0 && failed.length >= specs.length) {
      return (
        <div style={{ padding: 24, color: "var(--dash-danger, #dc2626)", ...style }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>This dashboard failed to load.</div>
          {failed.map((f) => (
            <div key={f.name} style={{ fontSize: 13, marginTop: 4 }}>
              <b>{f.name}:</b> {f.message}
            </div>
          ))}
        </div>
      );
    }
    return <div style={{ padding: 24, color: "var(--dash-muted, #666)", ...style }}>Loading…</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, ...style }}>
      {failed.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            marginBottom: 12,
            padding: "8px 12px",
            borderRadius: "var(--dash-radius, 8px)",
            background: "color-mix(in srgb, var(--dash-danger, #dc2626) 10%, transparent)",
            color: "var(--dash-danger, #dc2626)",
            fontSize: 13,
          }}
        >
          {failed.map((f) => `${f.name}: ${f.message}`).join(" · ")}
        </div>
      )}
      {/* Spike loading affordance: a thin top bar until every tile's data is in. */}
      {pending.length > 0 && (
        <div style={{ flexShrink: 0, height: 2, marginBottom: 6, background: "var(--dash-border, #e5e7eb)" }}>
          <div
            style={{
              height: "100%",
              width: `${((specs.length - pending.length) / specs.length) * 100}%`,
              background: "var(--dash-accent, #2563eb)",
              transition: "width .2s",
            }}
          />
        </div>
      )}
      <Panel result={combined} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

// A small popup shown at the cursor when a drilled dimension offers more than one
// target (e.g. open a dashboard vs. filter in place). Fixed-position, above
// everything; a full-viewport backdrop dismisses it.
function DrillMenu({ menu, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2000 }} />
      <div
        style={{
          position: "fixed",
          left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 220),
          top: menu.y,
          zIndex: 2001,
          minWidth: 180,
          padding: 4,
          background: "var(--dash-control-bg, #fff)",
          color: "var(--dash-fg, #171717)",
          border: "1px solid var(--dash-border, #e5e7eb)",
          borderRadius: "var(--dash-radius, 8px)",
          boxShadow: "0 8px 24px rgba(0,0,0,.16)",
          font: "14px var(--dash-font, system-ui, sans-serif)",
        }}
      >
        {menu.items.map((it, i) => (
          <button
            key={i}
            onClick={() => {
              it.run();
              onClose();
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dash-controls-bg, #f3f4f6)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              border: "none",
              background: "transparent",
              color: "inherit",
              font: "inherit",
              padding: "7px 10px",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </>
  );
}

// ── mounting ────────────────────────────────────────────────────────
// Coerce a URL-string given value to the given's declared Malloy type.
// filter<T> given values ARE strings (filter expression source) — no coercion.
function coerceGiven(raw, type) {
  if (type === "number") return raw === "" ? raw : Number(raw);
  if (type === "boolean") return raw === true || raw === "true";
  return raw;
}

function showFatal(msg) {
  const root = document.getElementById("root");
  if (!root) return;
  const pre = document.createElement("pre");
  pre.style.cssText =
    "color:crimson;white-space:pre-wrap;padding:16px;margin:0;font:12px ui-monospace,monospace;border-bottom:2px solid crimson";
  pre.textContent = "⚠ Dashboard error:\n" + msg;
  root.prepend(pre);
}
const isBenign = (msg) => typeof msg === "string" && msg.indexOf("ResizeObserver loop") !== -1;

class ErrorBoundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  render() {
    if (this.state.err) {
      return (
        <pre style={{ color: "crimson", whiteSpace: "pre-wrap", padding: 16 }}>
          {"⚠ Render error:\n" + (this.state.err.stack || String(this.state.err))}
        </pre>
      );
    }
    return this.props.children;
  }
}

// Shallow value equality over the union of keys — givens values are strings,
// numbers, booleans (filter-expression source or scalars), never objects.
function sameGivens(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function Root({ Dashboard, extraProps }) {
  // Seed givens: URL (shareable links) > the artifact tag's per-dashboard
  // defaults (`# artifact { givens { X="…" } }`) > the given declaration's
  // default. A given with no usable value is omitted — the model default
  // still applies at run time; the control just starts empty.
  const seed = useMemo(() => {
    const g = {};
    // URL givens are `$`-prefixed (`?$NAME=…`) — bare params are reserved for
    // future dimension filters. Normalize to a case-insensitive lookup so a
    // drilled dimension (`name`) matches its given (`NAME`) with no config.
    const fromUrl = window.__INITIAL_GIVENS__ || {};
    const urlByLower = {};
    for (const [k, v] of Object.entries(fromUrl)) {
      if (k[0] === "$") urlByLower[k.slice(1).toLowerCase()] = v;
    }
    const fromTag = dashboardInfo().givens || {};
    for (const spec of givenSpecs()) {
      const raw = urlByLower[spec.name.toLowerCase()];
      if (raw !== undefined && raw !== null) g[spec.name] = coerceGiven(raw, spec.type);
      else if (fromTag[spec.name] !== undefined) g[spec.name] = fromTag[spec.name];
      else if (spec.default !== undefined) g[spec.name] = spec.default;
    }
    return g;
  }, []);
  // Live by default; `# artifact { autorun=false }` stages changes behind Apply.
  const autorun = dashboardInfo().autorun !== false;
  // `committed` is what queries run with; `draft` is what the controls edit.
  // Live: every setGiven commits at once (draft === committed). Staged: setGiven
  // only touches the draft; apply() promotes it to committed.
  const [committed, setCommitted] = useState(seed);
  const [draft, setDraft] = useState(seed);
  const setGiven = useCallback(
    (name, value) => {
      setDraft((prev) => ({ ...prev, [name]: value }));
      if (autorun) setCommitted((prev) => ({ ...prev, [name]: value }));
    },
    [autorun],
  );
  const apply = useCallback(() => setCommitted(draft), [draft]);
  const reset = useCallback(() => setDraft(committed), [committed]);
  const dirty = !autorun && !sameGivens(draft, committed);
  // Reflect the COMMITTED givens up to the trusted parent so it mirrors the
  // applied state (not half-typed drafts) into the shareable URL.
  useEffect(() => {
    parent.postMessage({ type: "givens", givens: committed }, "*");
  }, [committed]);
  const ctx = useMemo(
    () => ({ givens: committed, draft, setGiven, apply, reset, dirty, autorun }),
    [committed, draft, setGiven, apply, reset, dirty, autorun],
  );
  return (
    <Ctx.Provider value={ctx}>
      <Dashboard
        dashboard={dashboardInfo()}
        givenSpecs={givenSpecs()}
        givens={committed}
        setGiven={setGiven}
        Panel={Panel}
        filters={filters}
        useGiven={useGiven}
        useOptions={useOptions}
        useQuery={useQuery}
        runData={runData}
        {...extraProps}
      />
    </Ctx.Provider>
  );
}

// ── default theme ───────────────────────────────────────────────────
// The Malloyyo look, expressed entirely as the `--dash-*` custom properties the
// widgets already read. Injected once at mount into document root, so it styles
// BOTH the no-code DefaultDashboard and any custom Dashboard.tsx. Authors
// override by setting the same vars on a wrapper element (more specific than
// :root wins) or via DefaultDashboard's `theme={{ accent: "…" }}` prop.
//
// Auto light/dark follows the viewer's OS via prefers-color-scheme. The results
// Panel keeps a light surface in both modes (--dash-panel-bg) because the Malloy
// renderer has no dark theme of its own — a dark shell with a light results card
// stays legible; override --dash-panel-bg if your renderer output is dark-safe.
const THEME_CSS = `
:root {
  --dash-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --dash-bg: #ffffff;
  --dash-fg: #171717;
  --dash-muted: #6b7280;
  --dash-border: #e5e7eb;
  --dash-accent: #2563eb;
  --dash-accent-fg: #ffffff;
  --dash-control-bg: #ffffff;
  --dash-controls-bg: #f9fafb;
  --dash-chip-bg: #eef2ff;
  --dash-chip-fg: #3730a3;
  --dash-panel-bg: #ffffff;
  --dash-radius: 8px;
  --dash-danger: #dc2626;
}
@media (prefers-color-scheme: dark) {
  :root {
    --dash-bg: #0a0a0a;
    --dash-fg: #ededed;
    --dash-muted: #9ca3af;
    --dash-border: #2a2a2a;
    --dash-accent: #3b82f6;
    --dash-accent-fg: #ffffff;
    --dash-control-bg: #171717;
    --dash-controls-bg: #141414;
    --dash-chip-bg: #1e293b;
    --dash-chip-fg: #bfdbfe;
    --dash-panel-bg: #ffffff;
    --dash-danger: #f87171;
  }
}
html, body { margin: 0; background: var(--dash-bg); color: var(--dash-fg); font-family: var(--dash-font); }
/* Drillable dimension cells (marked .dash-drill by the runtime): normal text,
   accent color on hover + pointer — matching the web app's clickable-item look. */
.dash-drill { cursor: pointer; }
.dash-drill:hover > .cell-content { color: var(--dash-accent, #2563eb); }
`;

function injectTheme() {
  if (typeof document === "undefined" || document.getElementById("dash-theme")) return;
  const style = document.createElement("style");
  style.id = "dash-theme";
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
}

// Drill (click a `# drill`-tagged dimension → navigate to another dashboard
// and/or filter in place) is wired in Panel via the renderer's onClick — see
// onCellClick there. The trusted parent resolves the real URL (only it knows the
// environment's dashboard shape: hosted /datasets/:id/dashboard/:slug vs local
// /?d=slug) from the structured {dashboard, givens} we post.

/** Frame entry point: mount a Dashboard component (custom or default). */
export function mount(Dashboard, extraProps) {
  injectTheme();
  window.addEventListener("error", (e) => {
    if (isBenign(e && e.message)) return;
    showFatal((e.error && e.error.stack) || e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (isBenign(r && r.message)) return;
    showFatal(String((r && (r.stack || r.message)) || r));
  });
  createRoot(document.getElementById("root")).render(
    <ErrorBoundary>
      <Root Dashboard={Dashboard} extraProps={extraProps} />
    </ErrorBoundary>,
  );
}
