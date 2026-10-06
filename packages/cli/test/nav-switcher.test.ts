// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The dashboard switcher, which `dashboard dev` and every `dashboard bundle`
// target render from this one function.
//
// Every test here is a bug that shipped. The switcher's job is "say where you
// are and let me go elsewhere", and it managed neither: the branch holding the
// current dashboard rendered collapsed on every page, because the open test
// compared a dataset NAME against the TITLE its callers pass for the button
// label — so a menu of four datasets opened showing four shut rows and no
// dashboards at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { switcherHtml, type SwitcherDataset } from "../src/shared/nav.js";

const TREE: SwitcherDataset[] = [
  {
    dataset: "sales",
    title: "Sales & Revenue",
    dashboards: [
      { slug: "sales/overview", title: "Overview", description: "By region." },
      { slug: "sales/detail", title: "Detail" },
    ],
  },
  {
    dataset: "the_look",
    title: "The Look",
    dashboards: [{ slug: "the_look/overview", title: "Look Overview" }],
  },
];

const link = (slug: string) => `./${slug.replace(/\//g, ".")}.html`;
/** The `<div class="grp">` opening tags, in tree order. */
const groups = (html: string) => html.match(/<div class="grp"[^>]*>/g) ?? [];

test("the branch holding the page you are on is the one that is open", () => {
  // Callers pass the dataset's TITLE as the button label, so an open test that
  // compared it to the dataset name was always false and nothing ever opened.
  const html = switcherHtml("sales/overview", TREE, link, {
    dataset: "Sales & Revenue",
    label: "Overview",
  });
  const g = groups(html);
  assert.equal(g.length, 2);
  assert.match(g[0] ?? "", /data-open="1"/, "the dataset you are in");
  assert.doesNotMatch(g[1] ?? "", /data-open="1"/, "and only that one");
  assert.match(html, /<button class="branch" aria-expanded="true">/, "aria agrees with it");
});

test("the other dataset's page opens the other branch", () => {
  const g = groups(switcherHtml("the_look/overview", TREE, link, { dataset: "The Look" }));
  assert.doesNotMatch(g[0] ?? "", /data-open="1"/);
  assert.match(g[1] ?? "", /data-open="1"/);
});

test("the landing page is in no dataset, so it opens none", () => {
  // `activeSlug` is "" there. Nothing should be forced open, and nothing should
  // match "" by accident either.
  const g = groups(switcherHtml("", TREE, link));
  assert.equal(g.filter((x) => x.includes('data-open="1"')).length, 0);
});

test("every link is the slug's address, never the dashboard's bare name", () => {
  const html = switcherHtml("sales/overview", TREE, link);
  assert.match(html, /href="\.\/sales\.overview\.html"/);
  assert.match(html, /href="\.\/the_look\.overview\.html"/);
  assert.doesNotMatch(html, /href="\.\/overview\.html"/, "which two datasets would share");
});

test("one dataset is not a tree: no branches, no filter box, nothing to expand", () => {
  // The single-dataset repo every published site is today.
  const html = switcherHtml("overview", [{ dataset: "", dashboards: TREE[0]!.dashboards }], link);
  assert.doesNotMatch(html, /class="branch"/);
  assert.doesNotMatch(html, /type="search"/);
  assert.match(html, /<div class="grp" data-open="1">/);
});

test("a filter can come up empty, so the panel carries a row that says so", () => {
  // `.dash-pick .empty` was in the stylesheet from the start; nothing emitted an
  // element with that class, so a search matching nothing drew a blank white box.
  const html = switcherHtml("sales/overview", TREE, link);
  assert.match(html, /<div class="empty" hidden>/, "present, and hidden until a search misses");
  // A flat list has no filter, so it needs no empty state.
  assert.doesNotMatch(
    switcherHtml("overview", [{ dataset: "", dashboards: [] }], link),
    /class="empty"/,
  );
});

test("names, titles and descriptions are escaped wherever they land", () => {
  const html = switcherHtml("x/a", [
    {
      dataset: "x",
      title: 'Sales "&" <Co>',
      dashboards: [{ slug: "x/a", title: "<b>A</b>", description: '"quoted" & <tagged>' }],
    },
  ], link);
  assert.doesNotMatch(html, /<b>A<\/b>/);
  assert.doesNotMatch(html, /<Co>/);
  assert.match(html, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.match(html, /title="&quot;quoted&quot; &amp; &lt;tagged&gt;"/);
});
