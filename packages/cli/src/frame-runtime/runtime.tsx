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

/** One given's value + setter + declaration spec: const state = useGiven("STATE"). */
export function useGiven(name) {
  const { givens, setGiven } = useDashboard();
  const spec = useMemo(() => givenSpecs().find((s) => s.name === name), [name]);
  return {
    value: givens[name],
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
  const spec = givenSpecs().find((s) => s.name === name);
  const suggest = spec && spec.suggest;
  const base = suggest ? suggestBase(suggest) : null;
  const term = (typed ?? "").trim();
  const [state, setState] = useState({ options: [], loading: !!base });
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    // With a known dimension the typed term refines server-side; otherwise the
    // full base list is fetched once (per given) and filtered client-side.
    const serverSide = !!suggest.dimension;
    const key = `${name}\0${serverSide ? term.toLowerCase() : ""}`;
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
        runData(q, {})
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
  }, [name, base, term]);
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
export function Panel({ query, malloy, givens, style }) {
  const req = malloy ? { malloy } : { query: query ?? dashboardInfo().query };
  const { result, loading, error } = useQuery({ ...req, givens });
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !result) return;
    const container = ref.current;
    let viz;
    try {
      const renderer = new MalloyRenderer({});
      viz = renderer.createViz({ tableConfig: { enableDrill: false }, scrollEl: container });
      viz.setResult(result);
      viz.render(container);
    } catch (err) {
      container.innerHTML = "";
      const pre = document.createElement("pre");
      pre.style.cssText = "color:crimson;white-space:pre-wrap;font:12px ui-monospace,monospace";
      pre.textContent = "Malloy render error:\n" + ((err && err.stack) || String(err));
      container.appendChild(pre);
      return;
    }
    return () => {
      try {
        viz && viz.remove();
      } catch {
        /* ignore */
      }
    };
  }, [result]);
  if (error) return <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre>;
  // display:grid + width:100% + a real min-height: the Malloy render web
  // component has no intrinsic height for charts/maps, so it collapses in a
  // plain block container.
  return (
    <div
      ref={ref}
      style={{
        display: "grid",
        width: "100%",
        minHeight: 480,
        overflow: "auto",
        opacity: loading ? 0.4 : 1,
        transition: "opacity .15s",
        ...style,
      }}
    />
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

function Root({ Dashboard, extraProps }) {
  // Seed givens: URL (shareable links) > the artifact tag's per-dashboard
  // defaults (`# artifact { givens { X="…" } }`) > the given declaration's
  // default. A given with no usable value is omitted — the model default
  // still applies at run time; the control just starts empty.
  const [givens, setGivens] = useState(() => {
    const g = {};
    const fromUrl = window.__INITIAL_GIVENS__ || {};
    const fromTag = dashboardInfo().givens || {};
    for (const spec of givenSpecs()) {
      const raw = fromUrl[spec.name];
      if (raw !== undefined && raw !== null) g[spec.name] = coerceGiven(raw, spec.type);
      else if (fromTag[spec.name] !== undefined) g[spec.name] = fromTag[spec.name];
      else if (spec.default !== undefined) g[spec.name] = spec.default;
    }
    return g;
  });
  const setGiven = useCallback((name, value) => {
    setGivens((prev) => ({ ...prev, [name]: value }));
  }, []);
  // Reflect givens up to the trusted parent so it can mirror them into the URL.
  useEffect(() => {
    parent.postMessage({ type: "givens", givens }, "*");
  }, [givens]);
  const ctx = useMemo(() => ({ givens, setGiven }), [givens, setGiven]);
  return (
    <Ctx.Provider value={ctx}>
      <Dashboard
        dashboard={dashboardInfo()}
        givenSpecs={givenSpecs()}
        givens={givens}
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

/** Frame entry point: mount a Dashboard component (custom or default). */
export function mount(Dashboard, extraProps) {
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
