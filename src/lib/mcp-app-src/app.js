// The dashboard panel, on the official MCP Apps SDK.
//
// Deliberately exercises the things a panel needs to be more than a picture:
// live DOM updates from user input, client-side sort/filter, SVG drawn from
// data, and the host bridge in the outbound direction (sendMessage puts text
// back into the conversation; openLink asks the host to open a URL).
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } =
  globalThis.__EXT_APPS__;

const root = document.getElementById("root");

const esc = (v) =>
  String(v).replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
const num = (v) => (typeof v === "number" ? v.toLocaleString() : esc(v));

// ---- state ----------------------------------------------------------------
let DATA = [];
let filter = "";
let sort = "count"; // "count" | "name"
let show = "both"; // "both" | "male" | "female"

// The query surface owns the envelope, so find the rows rather than assume.
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

function prepare(list) {
  let out = (list ?? []).map((r) => {
    const keys = Object.keys(r);
    return {
      name: String(r[keys.find((k) => typeof r[k] === "string") ?? keys[0]]),
      count: Number(r[keys.find((k) => typeof r[k] === "number")] ?? 0),
    };
  });
  if (filter) {
    const f = filter.toLowerCase();
    out = out.filter((x) => x.name.toLowerCase().includes(f));
  }
  out.sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.count - a.count));
  return out;
}

function bars(list) {
  if (!list.length) return `<p class="muted">no match</p>`;
  const max = Math.max(...list.map((x) => x.count), 1);
  return list
    .map(
      (x) => `<div class="bar">
        <span class="nm">${esc(x.name)}</span>
        <span class="track"><i style="width:${((x.count / max) * 100).toFixed(1)}%"></i></span>
        <span class="ct">${num(x.count)}</span>
      </div>`,
    )
    .join("");
}

function draw() {
  const decades = DATA.map((row) => {
    const male = prepare(row.male_names);
    const female = prepare(row.female_names);
    const cols = [];
    if (show !== "female") cols.push(`<div><h3>Boys</h3>${bars(male)}</div>`);
    if (show !== "male") cols.push(`<div><h3>Girls</h3>${bars(female)}</div>`);
    return `<section>
      <h2>${esc(row.decade)}s
        <span>${num(row.total_babies)} births</span>
        <button class="ask" data-decade="${esc(row.decade)}">Ask about this decade</button>
      </h2>
      <div class="cols">${cols.join("")}</div>
    </section>`;
  }).join("");

  root.className = "";
  root.innerHTML = `
    <header>
      <h1>Top names by decade</h1>
      <div class="controls">
        <input id="q" type="search" placeholder="filter names…" value="${esc(filter)}">
        <div class="seg" id="show">
          ${["both", "male", "female"]
            .map(
              (v) =>
                `<button data-show="${v}"${v === show ? ' class="on"' : ""}>${
                  v === "both" ? "Both" : v === "male" ? "Boys" : "Girls"
                }</button>`,
            )
            .join("")}
        </div>
        <div class="seg" id="sort">
          ${["count", "name"]
            .map(
              (v) =>
                `<button data-sort="${v}"${v === sort ? ' class="on"' : ""}>${
                  v === "count" ? "By births" : "A–Z"
                }</button>`,
            )
            .join("")}
        </div>
      </div>
    </header>
    ${decades}
    <p class="muted" id="status"></p>`;

  const q = document.getElementById("q");
  q.addEventListener("input", (e) => {
    filter = e.target.value;
    const at = e.target.selectionStart;
    draw();
    const nq = document.getElementById("q");
    nq.focus();
    nq.setSelectionRange(at, at);
  });
  root.querySelectorAll("[data-show]").forEach((b) =>
    b.addEventListener("click", () => {
      show = b.dataset.show;
      draw();
    }),
  );
  root.querySelectorAll("[data-sort]").forEach((b) =>
    b.addEventListener("click", () => {
      sort = b.dataset.sort;
      draw();
    }),
  );
  // Outbound bridge: put a question into the conversation from the panel.
  root.querySelectorAll("button.ask").forEach((b) =>
    b.addEventListener("click", async () => {
      const decade = b.dataset.decade;
      const status = document.getElementById("status");
      status.textContent = "sending…";
      try {
        const { isError } = await app.sendMessage({
          role: "user",
          content: [
            { type: "text", text: `Tell me what was happening in the ${decade}s that might explain these baby names.` },
          ],
        });
        status.textContent = isError ? "host rejected the message" : `asked about the ${decade}s`;
      } catch (e) {
        status.textContent = `sendMessage failed: ${e && e.message ? e.message : e}`;
      }
    }),
  );
}

function render(result) {
  const rows = findRows(result && result.structuredContent, 0);
  if (!rows) {
    root.innerHTML = `<h1>No rows</h1>`;
    return;
  }
  DATA = rows;
  draw();
}

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

const app = new App({ name: "Malloyyo Dashboard", version: "1.0.0" });

let rendered = false;
function renderOnce(result) {
  if (rendered) return;
  rendered = true;
  try {
    render(result);
  } catch (e) {
    console.error("render failed", e);
    root.innerHTML = `<h1>Render error</h1><pre>${esc(String((e && e.stack) || e))}</pre>`;
  }
}

// Handlers BEFORE connect(): tool-result is a one-shot the host may already hold.
app.ontoolresult = renderOnce;
app.onerror = console.error;
app.onhostcontextchanged = applyHostContext;
app.onteardown = async () => ({});

app.connect().then(async () => {
  applyHostContext(app.getHostContext());
  app.setupSizeChangedNotifications();
  const ctx = app.getHostContext();
  if (ctx && ctx.toolResult) renderOnce(ctx.toolResult);
  // Fallback only, and late: a dropped notification should not leave the panel
  // spinning, but firing early just stacks a second query behind the first.
  setTimeout(async () => {
    if (rendered) return;
    root.textContent = "Running query…";
    try {
      renderOnce(await app.callServerTool({ name: "show_dashboard", arguments: {} }));
    } catch (e) {
      root.innerHTML = `<h1>Query failed</h1><pre>${esc(String((e && e.message) || e))}</pre>`;
    }
  }, 8000);
});
