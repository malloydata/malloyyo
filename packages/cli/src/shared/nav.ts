// The dashboard switcher bar, in ONE place.
//
// `dashboard dev` and every `dashboard bundle` target render the same bar; only
// the LINK SHAPE differs (`/?d=name` for the dev server, `./name.html` or a
// clean `/name` for the bundle targets). That difference is a callback, not a
// reason to keep two copies — the previous two copies had already drifted in
// styling, and the same drift is what produced the givens-URL bug.
//
// Dependency-free so the Node dev server and the emitted static site share it.

export interface NavDashboard {
  name: string;
  title?: string;
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
  const brand =
    `<a class="brand" href="${esc(homeHref)}" title="Home" aria-label="Home">${HOME_ICON}</a>`;
  if (all.length <= 1) return `<nav class="dash-nav">${brand}</nav>`;
  const links = all
    .map(
      (x) =>
        `<a href="${esc(href(x.name))}"${x.name === active ? ' class="on"' : ""}>` +
        `${esc(x.title || x.name)}</a>`,
    )
    .join("");
  return `<nav class="dash-nav">${brand}<span class="sep"></span>${links}</nav>`;
}
