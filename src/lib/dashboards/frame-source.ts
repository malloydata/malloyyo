// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Browser runtime for the sandboxed dashboard iframe, kept as a STRING so the
// Next/tsc build never type-checks browser JSX with a virtual import. Bundled at
// request time by bundle.ts (esbuild, tsx loader). String.raw so "\n" stays a
// two-char escape in the emitted JS source (the browser parses it to a newline).
//
// Contract handed to the artifact's Dashboard.tsx (default export):
//   { manifest, givens, setGiven, Panel }
// The Panel runs the dashboard's declared query (server-fixed) with the current
// givens via a postMessage bridge to the trusted parent page, and renders the
// result with @malloydata/render.
export const FRAME_SOURCE = String.raw`
// React + ReactDOM + the Malloy renderer come from the prebuilt vendor bundle
// (window.__DASH_VENDOR__), so the runtime bundle carries none of their deps.
import Dashboard from "virtual:dashboard";
const __V = window.__DASH_VENDOR__;
const React = __V.React;
const useState = React.useState, useEffect = React.useEffect, useRef = React.useRef, useCallback = React.useCallback;
const createRoot = __V.createRoot;
const MalloyRenderer = __V.MalloyRenderer;

const manifest = window.__MANIFEST__;

function showFatal(msg) {
  const root = document.getElementById("root");
  if (!root) return;
  const pre = document.createElement("pre");
  pre.style.cssText = "color:crimson;white-space:pre-wrap;padding:16px;margin:0;font:12px ui-monospace,monospace";
  pre.textContent = "Dashboard error:\n" + msg;
  root.prepend(pre);
}
function isBenign(msg) { return typeof msg === "string" && msg.indexOf("ResizeObserver loop") !== -1; }
window.addEventListener("error", function (e) { if (isBenign(e && e.message)) return; showFatal((e.error && e.error.stack) || e.message); });
window.addEventListener("unhandledrejection", function (e) { const r = e.reason; if (isBenign(r && r.message)) return; showFatal(String((r && (r.stack || r.message)) || r)); });

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err: err }; }
  render() {
    if (this.state.err) {
      return React.createElement("pre", { style: { color: "crimson", whiteSpace: "pre-wrap", padding: 16 } }, "Render error:\n" + (this.state.err.stack || String(this.state.err)));
    }
    return this.props.children;
  }
}

let seq = 0;
const pending = new Map();
window.addEventListener("message", function (e) {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (m && m.type === "result" && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function runQuery(givens) {
  const id = ++seq;
  return new Promise(function (resolve) { pending.set(id, resolve); parent.postMessage({ type: "run", id: id, givens: givens }, "*"); });
}

function Panel(props) {
  const givens = props.givens;
  const ref = useRef(null);
  const [state, setState] = useState({ loading: true });
  const key = JSON.stringify(givens);
  useEffect(function () {
    let cancelled = false;
    setState(function (s) { return Object.assign({}, s, { loading: true }); });
    runQuery(givens).then(function (m) {
      if (cancelled) return;
      if (m.ok) setState({ loading: false, result: m.stableResult });
      else setState({ loading: false, error: String(m.error) });
    });
    return function () { cancelled = true; };
  }, [key]);
  useEffect(function () {
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
      pre.textContent = "Malloy render error:\n" + ((err && err.stack) || String(err));
      container.appendChild(pre);
      return;
    }
    return function () { try { if (viz) viz.remove(); } catch (e) {} };
  }, [state.result]);
  if (state.error) return React.createElement("pre", { style: { color: "crimson", whiteSpace: "pre-wrap" } }, state.error);
  return React.createElement("div", { ref: ref, style: { display: "grid", width: "100%", minHeight: 480, overflow: "auto", opacity: state.loading ? 0.4 : 1, transition: "opacity .15s" } });
}

function Root() {
  // Seed givens from the URL (window.__INITIAL_GIVENS__, injected by the frame
  // route from its query) so a shared link opens in that filtered state; fall
  // back to the manifest defaults.
  const initial = {};
  const fromUrl = window.__INITIAL_GIVENS__ || {};
  const specs = manifest.givens || [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const raw = fromUrl[spec.name];
    if (raw !== undefined && raw !== null && raw !== "") {
      initial[spec.name] = spec.type === "number" ? Number(raw) : raw;
    } else {
      initial[spec.name] = spec.default;
    }
  }
  const [givens, setGivens] = useState(initial);
  const setGiven = useCallback(function (name, value) {
    setGivens(function (prev) { const next = Object.assign({}, prev); next[name] = value; return next; });
  }, []);
  // Reflect givens up to the trusted parent so it can mirror them into the URL.
  useEffect(function () { parent.postMessage({ type: "givens", givens: givens }, "*"); }, [givens]);
  return React.createElement(Dashboard, { manifest: manifest, givens: givens, setGiven: setGiven, Panel: Panel });
}

createRoot(document.getElementById("root")).render(React.createElement(ErrorBoundary, null, React.createElement(Root, null)));
`;
