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
// Malloy text — the server's restricted mode is the gate). The result shape is
// normalized across hosts (dev server: {stable_result, problems[]}; hosted:
// {stableResult, error}).
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
  const givens = req.givens ?? {};
  const key = JSON.stringify([wire, givens]);
  const [state, setState] = useState({ rows: [], loading: true });
  useEffect(() => {
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

// Slug → menu label: "category_dashboard"/"brand-explorer" → "Category dashboard".
function humanizeSlug(s) {
  const t = String(s).replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// The renderer gives no per-cell field id, but each cell carries an inline
// `grid-column: N / …` and each table's header cells (.th) hold the field names.
const gridColStart = (el) => {
  const m = (el.style && el.style.gridColumn ? el.style.gridColumn : "").match(/^\s*(\d+)/);
  return m ? m[1] : null;
};

// Names of the fields that declare `# drill`, from the renderer's metadata
// (includes any `# label` so we can match either against the header text).
function drillFieldNames(viz) {
  const names = new Set();
  try {
    const fields = viz.getMetadata() ? viz.getMetadata().getAllFields() : [];
    for (const f of fields) {
      if (f && f.tag && f.tag.tag && f.tag.tag("drill")) {
        names.add(String(f.name));
        const label = f.tag.text && f.tag.text("label");
        if (label) names.add(label);
      }
    }
  } catch {
    /* metadata unavailable — no affordance, clicks still work */
  }
  return names;
}

// Tag drillable cells with `dash-drill` (styled as links via THEME_CSS) so users
// can see they're clickable. Per table: header .th cells at a drillable field →
// that column's grid-column → mark this table's own body .td cells in that column.
function markDrillableCells(container, names) {
  if (!names.size) return;
  for (const table of container.querySelectorAll(".malloy-table")) {
    const mine = (el) => el.closest(".malloy-table") === table; // skip nested tables
    const cols = new Set();
    for (const th of table.querySelectorAll(".column-cell.th")) {
      if (!mine(th)) continue;
      const text = (th.textContent || "").replace(/​/g, "").trim();
      const gc = gridColStart(th);
      if (gc && names.has(text)) cols.add(gc);
    }
    if (!cols.size) continue;
    for (const td of table.querySelectorAll(".column-cell.td")) {
      // Only leaf value cells — never a cell that wraps a nested table.
      if (mine(td) && cols.has(gridColStart(td)) && !td.querySelector(".malloy-table")) {
        td.classList.add("dash-drill");
      }
    }
  }
}

// ── Panel: run a query, render with Malloy's renderer ───────────────
export function Panel({ query, malloy, givens, style }) {
  const req = malloy ? { malloy } : { query: query ?? dashboardInfo().query };
  const { result, loading, error } = useQuery({ ...req, givens });
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
    if (!payload || payload.isHeader) return;
    const f = payload.field;
    // Only dimensions drill — a measure/aggregate click shouldn't navigate.
    if (!f || typeof f.wasDimension !== "function" || !f.wasDimension()) return;
    const drillTag = f.tag && f.tag.tag("drill");
    // `to=[a, self]` (array) or `to=x` (single) — a dest is a dashboard slug or `self`.
    const dests = drillTag && (drillTag.textArray("to") ?? (drillTag.text("to") ? [drillTag.text("to")] : []));
    if (!dests || !dests.length || payload.value == null) return;
    const given = String(f.name).toUpperCase(); // category → CATEGORY
    const filterExpr = filters.oneOf(String(payload.value)); // exact-match, escaped
    // `self` needs a matching given on THIS dashboard to filter in place.
    const selfSpec = givenSpecs().find((s) => s.name.toUpperCase() === given);
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
