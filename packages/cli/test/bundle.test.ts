// Unit tests for the pure pieces of `dashboard bundle`.
//
// These exist because of a specific bug: the dev server and the static bundle
// each had their OWN copy of the URL<->givens encoding, and the copies drifted.
// The static one stripped the `$` prefix that the runtime keys off
// (runtime.tsx: `if (k[0] === "$")`), so every shareable link silently fell back
// to its default value. The encoding now lives in one module; these tests pin
// the contract so a future edit can't quietly change it again.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  givensFromSearch,
  givensToParams,
  shareSearch,
  urlStateFromSearch,
  urlStateToParams,
} from "../src/shared/givens-url.js";
import {
  findTableRefs,
  indexPage,
  isDataFile,
  reachableModelFiles,
  tableFilePlan,
} from "../src/bundle.js";

test("reachableModelFiles follows imports and ignores unreferenced files", () => {
  // The case this exists for: a leftover gs.malloy next to the storage file that
  // is actually imported. Scanning it too would preload a second copy of the data.
  const files = {
    "file:///dashboards/d.malloy": `import "../index.malloy"`,
    "file:///index.malloy": `import { x } from './model.malloy'`,
    "file:///model.malloy": `import "storage.malloy"`,
    "file:///storage.malloy": "source: t is duckdb.table('docs/x.parquet')",
    "file:///gs.malloy": "source: t is duckdb.table('https://example.com/x.parquet')",
  };
  const out = reachableModelFiles(files, ["dashboards/d.malloy"]);
  assert.deepEqual(Object.keys(out).sort(), [
    "file:///dashboards/d.malloy",
    "file:///index.malloy",
    "file:///model.malloy",
    "file:///storage.malloy",
  ]);
  assert.equal("file:///gs.malloy" in out, false);
  // …and therefore only the imported storage file's table is planned.
  assert.deepEqual(tableFilePlan(out, "docs").map, { "docs/x.parquet": "./x.parquet" });
});

test("reachableModelFiles survives a cycle and a missing import", () => {
  const files = {
    "file:///a.malloy": `import "b.malloy"\nimport "nope.malloy"`,
    "file:///b.malloy": `import "a.malloy"`,
  };
  assert.deepEqual(Object.keys(reachableModelFiles(files, ["a.malloy"])).sort(), [
    "file:///a.malloy",
    "file:///b.malloy",
  ]);
});

test("givensFromSearch keeps the $ prefix the runtime keys off", () => {
  // The runtime ignores any key that does not start with `$`, so stripping the
  // prefix here is indistinguishable from passing nothing at all.
  assert.deepEqual(givensFromSearch("?$NAME=Emma"), { $NAME: "Emma" });
  assert.deepEqual(givensFromSearch("$NAME=Emma&$STATE=NY"), { $NAME: "Emma", $STATE: "NY" });
});

test("givensFromSearch drops the dashboard selector but nothing else", () => {
  assert.deepEqual(givensFromSearch("?d=name_explorer&$NAME=Emma"), { $NAME: "Emma" });
  // A bare (non-$) param is not a given, but it is also not `d` — keep it so a
  // future dimension-filter syntax isn't silently discarded here.
  assert.deepEqual(givensFromSearch("?d=x&other=1"), { other: "1" });
});

test("givensFromSearch handles an empty query", () => {
  assert.deepEqual(givensFromSearch(""), {});
  assert.deepEqual(givensFromSearch("?"), {});
});

test("givensFromSearch decodes values", () => {
  assert.deepEqual(givensFromSearch("?$NAME=Mary%20Jane"), { $NAME: "Mary Jane" });
});

test("givensToParams prefixes bare names and passes through prefixed ones", () => {
  assert.equal(givensToParams({ NAME: "Emma" }).toString(), "%24NAME=Emma");
  assert.equal(givensToParams({ $NAME: "Emma" }).toString(), "%24NAME=Emma");
});

test("givensToParams skips empty and nullish values", () => {
  const p = givensToParams({ NAME: "Emma", STATE: "", YEAR: null, X: undefined });
  assert.equal(p.toString(), "%24NAME=Emma");
});

test("givensToParams round-trips through givensFromSearch", () => {
  const out = givensFromSearch("?" + givensToParams({ NAME: "Emma", STATE: "NY" }).toString());
  assert.deepEqual(out, { $NAME: "Emma", $STATE: "NY" });
});

// ── useUrlState's `~` namespace ─────────────────────────────────────
// Custom-component view-state (a rack, a board) lives beside the givens in one
// query string. The two must never bleed into each other: a `~` param parsed as
// a given would reach the query layer, and a `$` param parsed as view-state
// would break the shareable link on reload.

test("givensFromSearch drops the ~ view-state namespace", () => {
  assert.deepEqual(givensFromSearch("?$NAME=Emma&~rack=retinas"), { $NAME: "Emma" });
});

test("urlStateFromSearch keeps the ~ prefix and takes nothing else", () => {
  assert.deepEqual(urlStateFromSearch("?d=anagram&$NAME=Emma&~rack=retinas&~reuse=true"), {
    "~rack": "retinas",
    "~reuse": "true",
  });
  assert.deepEqual(urlStateFromSearch("?$NAME=Emma"), {});
  assert.deepEqual(urlStateFromSearch(""), {});
});

test("urlStateToParams prefixes bare keys and KEEPS empty values", () => {
  // Unlike a given, "" is meaningful view-state: the user cleared a field whose
  // default is non-empty. Only null/undefined are dropped.
  assert.equal(urlStateToParams({ rack: "cats" }).toString(), "%7Erack=cats");
  assert.equal(urlStateToParams({ "~rack": "cats" }).toString(), "%7Erack=cats");
  assert.equal(urlStateToParams({ rack: "", x: null, y: undefined }).toString(), "%7Erack=");
});

test("urlStateToParams round-trips through urlStateFromSearch", () => {
  const out = urlStateFromSearch("?" + urlStateToParams({ board: "..a...#.", reuse: true }).toString());
  assert.deepEqual(out, { "~board": "..a...#.", "~reuse": "true" });
});

test("shareSearch emits d, then givens, then view-state — each namespace intact", () => {
  const s = shareSearch({ d: "anagram", givens: { MINLEN: 3 }, urlState: { rack: "retinas?" } });
  const parsed = new URLSearchParams(s);
  assert.equal(parsed.get("d"), "anagram");
  assert.equal(parsed.get("$MINLEN"), "3");
  assert.equal(parsed.get("~rack"), "retinas?");
  // And splitting it back apart returns exactly what went in.
  assert.deepEqual(givensFromSearch(s), { $MINLEN: "3" });
  assert.deepEqual(urlStateFromSearch(s), { "~rack": "retinas?" });
});

test("shareSearch omits the selector and empty maps", () => {
  assert.equal(shareSearch({}), "");
  assert.equal(shareSearch({ givens: {}, urlState: {} }), "");
  assert.equal(shareSearch({ urlState: { rack: "cat" } }), "?%7Erack=cat");
});

test("tableFilePlan maps an https table to itself and copies nothing", () => {
  const files = {
    "file:///storage.malloy":
      "source: t is duckdb.table('https://storage.googleapis.com/b/x.parquet')",
  };
  const { map, copies } = tableFilePlan(files, "docs");
  assert.deepEqual(map, {
    "https://storage.googleapis.com/b/x.parquet": "https://storage.googleapis.com/b/x.parquet",
  });
  assert.deepEqual(copies, []);
});

test("tableFilePlan copies a file that lives outside the site", () => {
  // The KEY must stay exactly what the model wrote — DuckDB looks the file up by
  // that name, so rewriting it would break the model.
  const files = { "file:///storage.malloy": "source: t is duckdb.table('data/x.parquet')" };
  const { map, copies } = tableFilePlan(files, "docs");
  assert.deepEqual(map, { "data/x.parquet": "./data/x.parquet" });
  assert.deepEqual(copies, ["data/x.parquet"]);
});

test("tableFilePlan rebases a file already inside the site, without copying", () => {
  // docs/x.parquet published from docs/ is served at ./x.parquet — and since it
  // is already in place, it stays in git exactly once.
  const files = { "file:///storage.malloy": "source: t is duckdb.table('docs/x.parquet')" };
  const { map, copies } = tableFilePlan(files, "docs");
  assert.deepEqual(map, { "docs/x.parquet": "./x.parquet" });
  assert.deepEqual(copies, []);
});

test("tableFilePlan rebases nested paths inside the site", () => {
  const files = { "file:///s.malloy": "source: t is duckdb.table('docs/data/x.parquet')" };
  assert.deepEqual(tableFilePlan(files, "docs").map, { "docs/data/x.parquet": "./data/x.parquet" });
});

test("tableFilePlan excludes warehouse tables", () => {
  // md.table('db.tbl') is not fetchable; listing it would make the page try.
  const files = { "file:///md.malloy": "source: t is md.table('mayolo.baby_names')" };
  assert.deepEqual(tableFilePlan(files, "docs"), { map: {}, copies: [] });
});

test("isDataFile distinguishes files from warehouse references", () => {
  assert.equal(isDataFile("https://example.com/a.parquet"), true);
  assert.equal(isDataFile("data/a.parquet"), true);
  assert.equal(isDataFile("data/a.csv"), true);
  assert.equal(isDataFile("mayolo.baby_names"), false);
  assert.equal(isDataFile("db.schema.tbl"), false);
});

test("findTableRefs dedupes across files and handles both quote styles", () => {
  const files = {
    "file:///one.malloy": "source: x is duckdb.table('b.parquet')\nsource: y is duckdb.table('a.parquet')",
    "file:///two.malloy": 'source: z is duckdb.table("b.parquet")',
  };
  assert.deepEqual(findTableRefs(files), ["a.parquet", "b.parquet"]);
});

// ── The landing page's own links ─────────────────────────────────────────────
//
// Every address on a bundled site is built from a dashboard's SLUG, by
// `pageLink`. The landing page passed the bare `name` instead. In a
// single-dataset repo name === slug, so this was invisible; in a multi-dataset
// one the page on disk is `sales.overview.html` and every card on the front page
// pointed at `./overview.html`, and two datasets both publishing an `overview`
// collapsed onto one dead href.

// `query` matters: a dashboard with neither a query nor tiles is the About page
// itself, which `indexPage` filters OUT of the list it is introducing — so a
// fixture without one makes every assertion below pass against an empty page.
const DASHES = [
  { name: "overview", slug: "sales/overview", title: "Overview", description: "By region.", query: "overview" },
  { name: "overview", slug: "the_look/overview", title: "Look Overview", query: "overview" },
] as unknown as Parameters<typeof indexPage>[0];

/** The landing page's own cards, not the nav switcher that sits above them. */
const cards = (html: string) => [...html.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]!);

test("the landing page addresses dashboards by slug, like every other link", () => {
  const html = indexPage(DASHES, "multi", false, false, undefined);
  const hrefs = cards(html);
  assert.deepEqual(hrefs.sort(), ["./sales.overview.html", "./the_look.overview.html"]);
  // Two datasets publishing the same dashboard name must not share an href.
  assert.equal(new Set(hrefs).size, 2, "distinct links");
  assert.doesNotMatch(html, /href="\.\/overview\.html"/, "the page that does not exist");
});

test("a custom landing page gets the same addresses, and distinct keys", () => {
  // `window.__DASHBOARDS__` feeds a repo's own `dashboards/index.jsx`: dead
  // links there, plus two React children keyed the same.
  const html = indexPage(DASHES, "multi", true, false, undefined);
  const json = /__DASHBOARDS__ = (\[[\s\S]*?\]);/.exec(html)?.[1];
  assert.ok(json, "the injected list");
  const list = JSON.parse(json) as { name: string; href: string }[];
  assert.deepEqual(
    list.map((d) => d.href).sort(),
    ["./sales.overview.html", "./the_look.overview.html"],
  );
  assert.equal(new Set(list.map((d) => d.name)).size, 2, "and identifiable apart");
});

test("a single-dataset repo's landing page is byte-for-byte what it was", () => {
  // The shape every published site is today: slug === name, so nothing moves.
  const one = [
    { name: "overview", slug: "overview", title: "Overview", query: "overview" },
  ] as unknown as Parameters<typeof indexPage>[0];
  assert.deepEqual(cards(indexPage(one, "repo", false, false, undefined)), ["./overview.html"]);
  assert.deepEqual(cards(indexPage(one, "repo", false, true, undefined)), ["./overview"]);
});
