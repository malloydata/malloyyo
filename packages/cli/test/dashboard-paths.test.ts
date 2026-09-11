// The dev server's pages must work when something serves them under a prefix.
//
// These exist because of a specific bug: every URL the page resolved for itself
// was root-absolute (`/inpage.js`, `/?d=…`, `/events`, `/api/run`). Served from
// the origin root that is fine. Served under a prefix — code-server's
// `/proxy/4173/`, a reverse proxy, an embed — the browser resolves `/…` against
// the ORIGIN, so it asked the proxy's root for the script and got a 404. The
// page rendered its nav and styles with no JavaScript at all, and the switcher
// links navigated out of the dashboard entirely.
//
// A relative reference resolves against the document, which is correct at any
// depth, including the root. These pin that so a future edit can't quietly put
// the leading slash back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PATHS, inlineScript } from "../src/dashboard.js";

/** Every path the shells emit, with a representative argument. */
const emitted = (): string[] => [
  DEV_PATHS.dashboard("overview_dashboard"),
  DEV_PATHS.inPage("overview_dashboard"),
  DEV_PATHS.bundle("overview_dashboard"),
  DEV_PATHS.events,
  DEV_PATHS.run,
];

test("no path the page resolves for itself is root-absolute", () => {
  for (const p of emitted()) {
    assert.ok(
      !p.startsWith("/"),
      `${JSON.stringify(p)} is root-absolute — under a proxy prefix the browser ` +
        `resolves it against the origin, not the dashboard`,
    );
  }
});

test("nor absolute in the other direction — a full URL pins the origin too", () => {
  for (const p of emitted()) {
    assert.ok(
      !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith("//"),
      `${JSON.stringify(p)} names an origin; the page must not care which one it is served from`,
    );
  }
});

test("they resolve under a proxy prefix the way the browser will", () => {
  // Exactly the shape that was broken: code-server serving the dev server at
  // /proxy/4173/. `new URL(rel, base)` is the browser's own algorithm.
  const base = "http://localhost:8080/proxy/4173/?d=overview_dashboard";
  assert.equal(
    new URL(DEV_PATHS.inPage("overview_dashboard"), base).pathname,
    "/proxy/4173/inpage.js",
  );
  assert.equal(new URL(DEV_PATHS.events, base).pathname, "/proxy/4173/events");
  assert.equal(new URL(DEV_PATHS.run, base).pathname, "/proxy/4173/api/run");
  assert.equal(
    new URL(DEV_PATHS.dashboard("seasonality"), base).href,
    "http://localhost:8080/proxy/4173/?d=seasonality",
  );
});

test("and still resolve correctly at the origin root", () => {
  // The direct `malloyyo dashboard dev` case, which must not regress.
  const base = "http://localhost:4173/?d=overview_dashboard";
  assert.equal(new URL(DEV_PATHS.inPage("overview_dashboard"), base).pathname, "/inpage.js");
  assert.equal(new URL(DEV_PATHS.events, base).pathname, "/events");
  assert.equal(new URL(DEV_PATHS.run, base).pathname, "/api/run");
  assert.equal(
    new URL(DEV_PATHS.dashboard("seasonality"), base).href,
    "http://localhost:4173/?d=seasonality",
  );
});

test("dashboard names are encoded, not interpolated raw", () => {
  const link = DEV_PATHS.dashboard("a b&c=d");
  assert.ok(!link.includes(" "), "a space would truncate the attribute");
  assert.equal(new URL(link, "http://x/").searchParams.get("d"), "a b&c=d");
  assert.equal(
    new URL(DEV_PATHS.inPage("a b&c=d"), "http://x/").searchParams.get("d"),
    "a b&c=d",
  );
});

// ---------------------------------------------------------------------------
// The bundle is now INLINED into the frame document, so the escaping below is
// load-bearing: an unescaped `</script` in a dashboard's compiled code would
// terminate the script element early and spill the rest of the bundle into the
// page as markup. Today's bundles happen to contain none, which is a property of
// the data and not a guarantee — so pin the escaping rather than our luck.
test("a bundle containing </script> cannot break out of the script element", () => {
  const hostile = `var a = "</script><img src=x onerror=alert(1)>";`;
  const escaped = inlineScript(hostile);
  assert.ok(!/<\/script/i.test(escaped), "an unescaped </script survived");
  // The escape must not change what the JS means: `\/` is just `/` to a parser,
  // so the string literal still evaluates to the original text.
  const literal = escaped.slice(escaped.indexOf('"'), escaped.lastIndexOf('"') + 1);
  assert.equal(JSON.parse(literal), '</script><img src=x onerror=alert(1)>');
});

test("escaping is case-insensitive and handles repeats", () => {
  const out = inlineScript(`a="</SCRIPT>"; b="</script >"; c="</script";`);
  assert.ok(!/<\/script/i.test(out), out);
  assert.equal((out.match(/<\\\/script/gi) ?? []).length, 3);
});

test("escaping leaves ordinary code untouched", () => {
  const plain = `const x = 1 < 2 ? "a/b" : "c";`;
  assert.equal(inlineScript(plain), plain);
});

// ---------------------------------------------------------------------------
// DEV_PATHS covers the server-rendered templates, but the BROWSER RUNTIME has its
// own copies — and that is exactly how a root-absolute `fetch("/api/run")` in
// frame-inpage-entry.tsx survived the first fix and kept the proxied dashboard
// broken. A table of paths cannot guard code it does not own, so scan the sources
// that get compiled into the page.
test("no runtime source resolves a root-absolute URL", () => {
  // Relative to THIS FILE, not the cwd — the suite is run from the repo root.
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
  const roots = [
    join(pkg, "src/frame-inpage-entry.tsx"),
    join(pkg, "src/frame-entry.tsx"),
    join(pkg, "src/frame-wasm-entry.tsx"),
  ];
  const dirs = [join(pkg, "src/frame-runtime"), join(pkg, "src/shared")];
  const files: string[] = [];
  for (const r of roots) if (existsSync(r)) files.push(r);
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/\.(ts|tsx)$/.test(f)) files.push(join(d, f));
  }
  assert.ok(files.length > 0, "found no runtime sources to scan — has the layout moved?");

  // fetch("/x"), new EventSource('/x'), el.src = "/x", href="/x"
  const offender = /(?:fetch|EventSource|open)\s*\(\s*["'`]\/[a-z]|(?:\.src|href)\s*=\s*["'`]\/[a-z]/i;
  const bad: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trim().startsWith("//")) return;
        if (offender.test(line)) bad.push(`${relative(pkg, f)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
  }
  assert.deepEqual(
    bad,
    [],
    `root-absolute URL(s) in runtime source — these resolve against the ORIGIN, so ` +
      `they break whenever the page is served under a proxy prefix:\n  ${bad.join("\n  ")}`,
  );
});
