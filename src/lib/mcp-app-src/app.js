// The Baby-names panel, written against the official MCP Apps SDK.
//
// Hand-rolling the postMessage handshake is what made this hard: the SDK owns
// the initialize exchange, the request handlers the host may send, teardown,
// size reporting and theming. The `App` class here comes from the inlined
// @modelcontextprotocol/ext-apps bundle — same SDK the reference app ships.
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } =
  globalThis.__EXT_APPS__;

const root = document.getElementById("root");

function esc(v) {
  return String(v).replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}
const num = (v) => (typeof v === "number" ? v.toLocaleString() : esc(v));

// The query surface owns the result envelope, so take the first array of
// objects rather than assuming a key.
function findRows(node, depth) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    return node.length && node[0] && typeof node[0] === "object" && !Array.isArray(node[0])
      ? node
      : null;
  }
  if (typeof node !== "object") return null;
  for (const k of Object.keys(node)) {
    const hit = findRows(node[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function nameList(label, list) {
  if (!Array.isArray(list) || !list.length) return "";
  const body = list
    .map((r) => {
      const keys = Object.keys(r);
      const nameKey = keys.find((k) => typeof r[k] === "string") ?? keys[0];
      const numKey = keys.find((k) => typeof r[k] === "number");
      return `<tr><td>${esc(r[nameKey])}</td><td class="n">${numKey ? num(r[numKey]) : ""}</td></tr>`;
    })
    .join("");
  return `<div><h3>${esc(label)}</h3><table>${body}</table></div>`;
}

function render(result) {
  const rows = findRows(result && result.structuredContent, 0);
  if (!rows) {
    const text = ((result && result.content) || [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join(" ");
    root.innerHTML = `<h1>No rows</h1><pre>${esc(text.slice(0, 4000))}</pre>`;
    return;
  }
  let html = "<h1>Top names by decade</h1>";
  for (const row of rows) {
    const nested = [];
    const scalars = [];
    for (const k of Object.keys(row)) (Array.isArray(row[k]) ? nested : scalars).push(k);
    const head = scalars[0];
    const rest = scalars.slice(1).map((k) => `${esc(k)} ${num(row[k])}`).join(" · ");
    html +=
      `<section><h2>${esc(row[head])}` +
      (rest ? `<span>${rest}</span>` : "") +
      `</h2><div class="cols">` +
      nested.map((k) => nameList(k.replace(/_/g, " "), row[k])).join("") +
      `</div></section>`;
  }
  root.className = "";
  root.innerHTML = html;
}

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

const app = new App({ name: "Malloyyo Dashboard", version: "1.0.0" });

// Handlers BEFORE connect(): the host may have already sent the tool result by
// the time the handshake completes, and these are one-shot events.
app.ontoolresult = render;
app.onerror = console.error;
app.onhostcontextchanged = applyHostContext;
app.onteardown = async () => ({});

app.connect().then(() => {
  applyHostContext(app.getHostContext());
  // Size reporting, driven by the SDK's own ResizeObserver.
  app.setupSizeChangedNotifications();
});
