// The dashboard switcher bar, in ONE place.
//
// `dashboard dev` and every `dashboard bundle` target render the same bar; only
// the LINK SHAPE differs (`/?d=name` for the dev server, `./name.html` or a
// clean `/name` for the bundle targets). That difference is a callback, not a
// reason to keep two copies — the previous two copies had already drifted in
// styling, and the same drift is what produced the givens-URL bug.
//
// Dependency-free so the Node dev server and the emitted static site share it.

import type { TreeDataset } from "@malloyyo/mcp-engine";

export interface NavDashboard {
  name: string;
  title?: string;
  /** The dataset it belongs to, in a repo that publishes more than one. Drawn
      as a divider between groups; absent in a single-dataset repo. */
  group?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The Malloy mark, inlined rather than shipped as a file so a site stays
    self-contained and a subpath deploy (GitHub Pages) can't 404 it. */
export const LOGO = `<svg viewBox="0 0 240 240" width="20" height="20" aria-hidden="true" focusable="false">\
<g transform="translate(8, 44)" fill-rule="nonzero" stroke-width="10">\
<path d="M66.8164971,8.04981927 C70.8741349,0.502462438 80.0934949,-2.2220379 87.4085141,1.96447745 C94.5645112,6.05998159 97.2471437,15.2521193 93.5616777,22.7156028 L93.3065249,23.2105325 L28.3940308,143.950181 C24.3363931,151.497538 15.117033,154.222038 7.80201383,150.035523 C0.646016803,145.940018 -2.0366157,136.747881 1.64885028,129.284397 L1.90400302,128.789468 L66.8164971,8.04981927 Z" stroke="#1573A1" fill="#1573A1"/>\
<path d="M192.878294,8.04981927 C196.98997,0.0579198953 207.437352,-1.75261923 213.470311,1.96447745 C219.503269,5.68157413 221.641451,12.7091374 223.25,15.6301759 L219.368321,23.2105325 L154.455827,143.950181 C150.39819,151.497538 141.17883,154.222038 133.86381,150.035523 C126.707813,145.940018 124.025181,136.747881 127.710647,129.284397 L127.9658,128.789468 L192.878294,8.04981927 Z" stroke="#FBBC04" fill="#FBBC04" transform="translate(174.655898, 76.056961) scale(-1, 1) translate(-174.655898, -76.056961)"/>\
<path d="M129.943475,8.04981927 C134.001113,0.502462438 143.220473,-2.2220379 150.535492,1.96447745 C157.691489,6.05998159 160.374122,15.2521193 156.688656,22.7156028 L156.433503,23.2105325 L91.5210087,143.950181 C87.463371,151.497538 78.2440109,154.222038 70.9289918,150.035523 C63.7729947,145.940018 61.0903622,136.747881 64.7758282,129.284397 L65.0309809,128.789468 L129.943475,8.04981927 Z" stroke="#E37400" fill="#E37400"/>\
<path d="M132.146094,8.04981927 C136.203731,0.502462438 145.423091,-2.2220379 152.738111,1.96447745 C159.894108,6.05998159 162.57674,15.2521193 158.891274,22.7156028 L158.636121,23.2105325 L93.7236274,143.950181 C89.6659896,151.497538 80.4466296,154.222038 73.1316104,150.035523 C65.9756133,145.940018 63.2929808,136.747881 66.9784468,129.284397 L67.2335996,128.789468 L132.146094,8.04981927 Z" stroke="#11B5CB" fill="#11B5CB" transform="translate(112.934861, 76.000000) scale(-1, 1) translate(-112.934861, -76.000000)"/>\
</g></svg>`;

/** Deliberately black in both light and dark schemes — this is a brand bar, not
    page chrome, so it shouldn't invert with the color scheme. */
export const NAV_CSS = `
.dash-nav{display:flex;gap:4px;align-items:center;padding:8px 14px;background:#000;font:13px system-ui,-apple-system,sans-serif;flex-wrap:wrap}
/* The home icon is an <a> too, so it opts OUT of the switcher-link padding and
   keeps its own square hit area. */
.dash-nav a.brand{display:inline-flex;align-items:center;justify-content:center;color:#9aa1ac;padding:5px;border-radius:6px;text-decoration:none}
.dash-nav a.brand:hover{background:#1f232a;color:#fff}
.dash-nav .brand svg{display:block}
.dash-nav .sep{width:1px;align-self:stretch;background:#2c3038;margin:0 10px}
.dash-nav a{padding:4px 10px;border-radius:6px;text-decoration:none;color:#c9ced6}
/* The switcher: the same control the hosted app uses, in vanilla. A row of
   pills stops working at about five dashboards — a repo with four datasets has
   fifteen — so the list moves into a menu and the bar keeps one button. */
.dash-pick{position:relative;font:13px system-ui,-apple-system,sans-serif}
.dash-pick>button{display:flex;align-items:center;gap:6px;max-width:60vw;padding:4px 8px;border:0;border-radius:6px;
  background:transparent;color:#c9ced6;font:inherit;cursor:pointer}
.dash-pick>button:hover{background:#1f232a;color:#fff}
.dash-pick .ds{font-weight:600;color:#fff}
.dash-pick .slash{color:#5b6270}
.dash-pick .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-pick .chev{flex:none;opacity:.6}
.dash-pick[data-open="1"] .panel{display:block}
.dash-pick .panel{display:none;position:absolute;left:0;top:100%;margin-top:4px;z-index:50;width:340px;max-width:92vw;
  background:#fff;color:#111;border:1px solid #d7dbe0;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.dash-pick .filter{padding:6px;border-bottom:1px solid #eceef1}
.dash-pick .filter input{width:100%;box-sizing:border-box;padding:5px 8px;border:0;border-radius:4px;background:#f3f4f6;
  font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#111}
.dash-pick .filter input:focus{outline:0}
.dash-pick .list{max-height:60vh;overflow-y:auto;padding:4px}
.dash-pick .branch{display:flex;align-items:center;gap:5px;width:100%;padding:4px 6px;border:0;border-radius:4px;
  background:transparent;font:inherit;font-weight:600;color:#111;cursor:pointer;text-align:left}
.dash-pick .branch:hover{background:#f3f4f6}
.dash-pick .branch .tw{flex:none;transition:transform .12s}
.dash-pick .branch[aria-expanded="true"] .tw{transform:rotate(90deg)}
.dash-pick .leaf{display:block;padding:4px 8px;border-radius:4px;text-decoration:none;color:#374151;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-pick .leaf:hover{background:#f3f4f6}
.dash-pick .leaf.on{background:#111;color:#fff}
.dash-pick .kids{display:none}
.dash-pick .kids.indent .leaf{margin-left:16px}
.dash-pick .grp[data-open="1"] .kids{display:block}
.dash-pick .empty{padding:6px 8px;color:#9aa1ac}
@media (prefers-color-scheme:dark){
  .dash-pick .panel{background:#0b0d11;color:#e6e8eb;border-color:#262b33}
  .dash-pick .filter{border-bottom-color:#1a1e25}
  .dash-pick .filter input{background:#14181e;color:#e6e8eb}
  .dash-pick .branch{color:#e6e8eb}
  .dash-pick .branch:hover,.dash-pick .leaf:hover{background:#171b22}
  .dash-pick .leaf{color:#c9ced6}
  .dash-pick .leaf.on{background:#fff;color:#000}
}
.dash-nav a:hover{background:#1f232a;color:#fff}
.dash-nav a.on{background:#fff;color:#000;font-weight:550}
`;

/** Render the bar. `href` maps a dashboard name to a link for THIS host — the
    only thing that varies across dev / pages / vercel. The brand shows even for
    a single dashboard; only the switcher links are conditional. */
export const MALLOYYO_REPO = "https://github.com/malloydata/malloyyo";

/** Home, back to the landing page. Attribution lives on that page rather than
    in the bar — the bar should be navigation. */
const HOME_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" \
stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">\
<path d="M3 10.2 12 3.5l9 6.7"/><path d="M5.2 8.9V20h13.6V8.9"/><path d="M9.6 20v-6.2h4.8V20"/></svg>`;

export function navHtml(
  active: string,
  all: NavDashboard[],
  href: (name: string) => string,
  homeHref = "./",
): string {
  // A repo with several datasets puts a divider between them, so a bar of
  // fourteen links reads as four groups. `group` is absent in a single-dataset
  // repo and the bar is exactly what it always was.
  const brand =
    `<a class="brand" href="${esc(homeHref)}" title="Home" aria-label="Home">${HOME_ICON}</a>`;
  if (all.length <= 1) return `<nav class="dash-nav">${brand}</nav>`;
  let group: string | undefined;
  const links = all
    .map((x) => {
      const divider = group !== undefined && x.group !== group ? '<span class="sep"></span>' : "";
      group = x.group;
      return (
        divider +
        `<a href="${esc(href(x.name))}"${x.name === active ? ' class="on"' : ""}` +
        `${x.group ? ` title="${esc(x.group)}"` : ""}>` +
        `${esc(x.title || x.name)}</a>`
      );
    })
    .join("");
  return `<nav class="dash-nav">${brand}<span class="sep"></span>${links}</nav>`;
}

/** The sibling list a host injects as `window.__DASHBOARDS__`, in nav order and
    excluding the current page.
 *
 * Same shape and same link-shape callback as `navHtml`, because it answers the
 * same question in component form: an About page (or any dashboard) that wants
 * to link to the others gets `props.dashboards` and never has to know whether it
 * is running under the dev server, the hosted frame, or a static bundle. */
export function siblingList<T extends NavDashboard & { description?: string }>(
  current: string,
  all: readonly T[],
  href: (name: string) => string,
): Array<{ name: string; title: string; description?: string; href: string }> {
  return all
    .filter((d) => d.name !== current)
    .map((d) => ({
      name: d.name,
      title: d.title || d.name,
      ...(d.description ? { description: d.description } : {}),
      href: href(d.name),
    }));
}

// ── The dashboard switcher ──────────────────────────────────────────────────

/**
 * The same control the hosted app puts in its header (src/components/
 * DashboardTree.tsx), in dependency-free HTML + a little script so the dev
 * server and every static bundle can render it.
 *
 * A row of pills stops scaling at about five dashboards — a repo with four
 * datasets has fifteen, wrapping onto three lines with two of them called
 * "About". So: one button saying where you are, and a menu holding everything.
 *
 * The tree is INLINED rather than fetched. A bundle is a static site with no
 * API to ask, and the dev server already knows the answer at render time.
 *
 * A single-dataset repo gets a flat list with no branches and no filter box —
 * the same judgement the hosted one makes, for the same reason: one dataset is
 * not a tree.
 */
export function switcherHtml(
  activeSlug: string,
  tree: TreeDataset[],
  href: (slug: string) => string,
  opts: { dataset?: string; label?: string } = {},
): string {
  const flat = tree.length <= 1;
  const slugOf = (ds: string, name: string) => (flat ? name : `${ds}/${name}`);

  const groups = tree
    .map((ds) => {
      const open = flat || ds.dataset === opts.dataset ? ' data-open="1"' : "";
      const leaves = ds.dashboards
        .map((d) => {
          const slug = slugOf(ds.dataset, d.name);
          const on = slug === activeSlug ? " on" : "";
          return (
            `<a class="leaf${on}" href="${esc(href(slug))}"` +
            `${d.description ? ` title="${esc(d.description)}"` : ""}` +
            ` data-find="${esc(`${ds.dataset} ${d.name} ${d.title}`.toLowerCase())}">` +
            `${esc(d.title || d.name)}</a>`
          );
        })
        .join("");
      if (flat) return `<div class="grp" data-open="1"><div class="kids">${leaves}</div></div>`;
      return (
        `<div class="grp"${open} data-ds="${esc(ds.dataset.toLowerCase())}">` +
        `<button class="branch" aria-expanded="${open ? "true" : "false"}">` +
        `<svg class="tw" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>` +
        `${esc(ds.dataset)}</button>` +
        `<div class="kids indent">${leaves}</div></div>`
      );
    })
    .join("");

  const filter = flat
    ? ""
    : `<div class="filter"><input type="search" placeholder="filter…" aria-label="Filter dashboards"></div>`;

  return (
    `<div class="dash-pick" data-open="0">` +
    `<button type="button" aria-haspopup="menu" aria-expanded="false" title="All datasets and dashboards">` +
    (opts.dataset ? `<span class="ds">${esc(opts.dataset)}</span><span class="slash">/</span>` : "") +
    `<span class="lbl">${esc(opts.label ?? "dashboards")}</span>` +
    `<svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>` +
    `</button>` +
    `<div class="panel" role="menu">${filter}<div class="list">${groups}</div></div>` +
    `</div>`
  );
}

/** The switcher's behaviour: open/close, filter, expand. Inline it once per
    page. Same rules as the hosted menu — Escape and a click outside close it,
    a search opens everything that matched (hiding a match behind a closed
    branch is the one thing a search must not do), and closing forgets it. */
export const SWITCHER_JS = `
(function(){
  var p=document.querySelector('.dash-pick'); if(!p) return;
  var btn=p.querySelector(':scope>button'), inp=p.querySelector('.filter input');
  var grps=[].slice.call(p.querySelectorAll('.grp'));
  function openState(on){
    p.dataset.open=on?'1':'0';
    btn.setAttribute('aria-expanded',on?'true':'false');
    if(!on&&inp){inp.value='';apply('');}
    if(on&&inp){inp.focus();}
  }
  function apply(q){
    q=q.trim().toLowerCase();
    grps.forEach(function(g){
      var ds=g.dataset.ds||'', dsHit=!!q&&ds.indexOf(q)>=0;
      var any=false;
      [].slice.call(g.querySelectorAll('.leaf')).forEach(function(a){
        var hit=!q||dsHit||(a.dataset.find||'').indexOf(q)>=0;
        a.style.display=hit?'':'none'; if(hit) any=true;
      });
      g.style.display=any?'':'none';
      // While searching, everything that survived is open.
      if(q) g.dataset.open=any?'1':'0';
      var b=g.querySelector('.branch'); if(b) b.setAttribute('aria-expanded',g.dataset.open==='1'?'true':'false');
    });
  }
  btn.addEventListener('click',function(e){e.stopPropagation();openState(p.dataset.open!=='1');});
  grps.forEach(function(g){
    var b=g.querySelector('.branch'); if(!b) return;
    b.addEventListener('click',function(e){
      e.stopPropagation();
      g.dataset.open=g.dataset.open==='1'?'0':'1';
      b.setAttribute('aria-expanded',g.dataset.open==='1'?'true':'false');
    });
  });
  if(inp){inp.addEventListener('input',function(){apply(inp.value);});
          inp.addEventListener('click',function(e){e.stopPropagation();});}
  document.addEventListener('click',function(){ if(p.dataset.open==='1') openState(false); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') openState(false); });
})();
`;
