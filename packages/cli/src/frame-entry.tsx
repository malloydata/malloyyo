// @ts-nocheck
// Browser entry for the SANDBOXED dashboard iframe. Bundled on demand by the
// dashboard dev server (esbuild, iife). This is the untrusted side: it holds no
// credentials and cannot reach the API directly (the frame is
// `sandbox="allow-scripts"`, so its origin is opaque and fetch is blocked). Its
// only channel is `postMessage` to the trusted parent shell, which runs the
// governed query and posts results back.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { MalloyRenderer } from "@malloydata/render";
// Aliased by the dev server to the dashboard's ./Dashboard.tsx.
import Dashboard from "virtual:dashboard";

const manifest = window.__MANIFEST__;

// Coerce a URL-string given value to the given's declared type. URL params are
// always strings, so "true"/"1990" must become boolean/number.
function coerceGiven(raw, type) {
  if (type === "number") return raw === "" ? raw : Number(raw);
  if (type === "boolean") return raw === true || raw === "true";
  return raw;
}

// Dev preview: surface errors on the page instead of blanking. A throw in the
// Malloy renderer (or anywhere) would otherwise crash the React tree silently.
function showFatal(msg) {
  const root = document.getElementById("root");
  if (!root) return;
  const pre = document.createElement("pre");
  pre.style.cssText =
    "color:crimson;white-space:pre-wrap;padding:16px;margin:0;font:12px ui-monospace,monospace;border-bottom:2px solid crimson";
  pre.textContent = "⚠ Dashboard error:\n" + msg;
  root.prepend(pre);
}
// "ResizeObserver loop completed…" is a benign warning the Vega/Malloy renderer
// emits — not a real error, so don't surface it.
const isBenign = (msg) => typeof msg === "string" && msg.indexOf("ResizeObserver loop") !== -1;
window.addEventListener("error", (e) => {
  if (isBenign(e && e.message)) return;
  showFatal((e.error && e.error.stack) || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  if (isBenign(r && r.message)) return;
  showFatal(String((r && (r.stack || r.message)) || r));
});

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

// --- bridge: ask the trusted parent to run a declared query with given values.
let seq = 0;
const pending = new Map();
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return; // only the trusted shell
  const m = e.data;
  if (m && m.type === "result" && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function runQuery(query, givens) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    parent.postMessage({ type: "run", id, query, givens }, "*");
  });
}

// A governed panel: runs a named query with the current givens and renders the
// result with Malloy's own renderer (same path the hosted app uses).
function Panel({ query, givens }) {
  const ref = useRef(null);
  const [state, setState] = useState({ loading: true });
  const q = query ?? manifest.query;
  const key = JSON.stringify(givens);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    runQuery(q, givens).then((m) => {
      if (cancelled) return;
      if (m.ok) setState({ loading: false, result: m.stable_result });
      else setState({ loading: false, error: JSON.stringify(m.problems, null, 2) });
    });
    return () => {
      cancelled = true;
    };
  }, [q, key]);
  useEffect(() => {
    if (!ref.current || !state.result) return;
    const container = ref.current;
    let viz;
    try {
      const renderer = new MalloyRenderer({});
      viz = renderer.createViz({ tableConfig: { enableDrill: false }, scrollEl: container });
      viz.setResult(state.result);
      viz.render(container);
    } catch (err) {
      container.innerHTML = "";
      const pre = document.createElement("pre");
      pre.style.cssText = "color:crimson;white-space:pre-wrap;font:12px ui-monospace,monospace";
      pre.textContent = "⚠ Malloy render error:\n" + ((err && err.stack) || String(err));
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
  }, [state.result]);
  if (state.error) return <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{state.error}</pre>;
  // display:grid + width:100% + a real min-height: the Malloy render web
  // component has no intrinsic height for charts/maps, so it collapses to
  // nothing in a plain block container (tables survive on row height). This
  // matches the hosted MalloyResultView container.
  return (
    <div
      ref={ref}
      style={{
        display: "grid",
        width: "100%",
        minHeight: 480,
        overflow: "auto",
        opacity: state.loading ? 0.4 : 1,
        transition: "opacity .15s",
      }}
    />
  );
}

function Root() {
  // Seed givens from the URL (window.__INITIAL_GIVENS__, injected by the frame
  // route) so a shared link opens filtered; else the manifest defaults.
  const [givens, setGivens] = useState(() => {
    const g = {};
    const fromUrl = window.__INITIAL_GIVENS__ || {};
    for (const spec of manifest.givens ?? []) {
      const raw = fromUrl[spec.name];
      // A param that's present (even empty) is used as-is (coerced to the given's
      // type); only an absent param falls back to the manifest default.
      g[spec.name] = raw !== undefined && raw !== null ? coerceGiven(raw, spec.type) : spec.default;
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
  return <Dashboard manifest={manifest} givens={givens} setGiven={setGiven} Panel={Panel} />;
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <Root />
  </ErrorBoundary>,
);
