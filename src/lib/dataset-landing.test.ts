// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The fallback chain behind `/datasets/<ref>`. Each step exists because the one
// before it can be empty, so the tests are mostly about what happens as each
// tier disappears.

import { test } from "node:test";
import assert from "node:assert/strict";
import { datasetLandingPath } from "./dataset-landing";


test("lands on the first dashboard", () => {
  assert.equal(
    datasetLandingPath("babynames", {
      dashboards: [{ name: "index" }, { name: "name_explorer" }],
      hasQuestions: true,
    }),
    "/datasets/babynames/dashboard/index",
  );
});

test("the first dashboard IS the About page when the repo ships one", () => {
  // listDashboards puts About first, so "the introduction, if there is one"
  // needs no special case here — but if that ordering ever regressed, this is
  // the test that would notice the front door moved.
  const path = datasetLandingPath("babynames", {
    dashboards: [{ name: "index" }, { name: "time-series" }],
    hasQuestions: false,
  });
  assert.match(path, /\/dashboard\/index$/);
});

test("no dashboards, but questions have been asked → Q&A", () => {
  assert.equal(
    datasetLandingPath("worldcup", { dashboards: [], hasQuestions: true }),
    "/datasets/worldcup/questions",
  );
});

test("nothing at all → ltool, with the first source selected", () => {
  // A dataset with neither is empty, not broken. ltool with no source is a blank
  // picker — the same dead end the config page was — so the source matters.
  assert.equal(
    datasetLandingPath("fresh", {
      dashboards: [],
      hasQuestions: false,
      firstSource: "order_items",
    }),
    "/ltool?dataset=fresh&source=order_items",
  );
});

test("ltool still works when the model declares no sources", () => {
  const path = datasetLandingPath("fresh", { dashboards: [], hasQuestions: false });
  assert.equal(path, "/ltool?dataset=fresh");
  assert.doesNotMatch(path, /source=/, "no empty source param");
  assert.doesNotMatch(path, /undefined|null/);
});

test("a dashboard beats questions, and questions beat ltool", () => {
  const all = { hasQuestions: true, firstSource: "s" };
  assert.match(datasetLandingPath("d", { ...all, dashboards: [{ name: "a" }] }), /\/dashboard\/a$/);
  assert.match(datasetLandingPath("d", { ...all, dashboards: [] }), /\/questions$/);
});

test("the ref is kept as given, so a name stays a name", () => {
  // Redirecting a readable name to a uuid would be a worse address bar than the
  // one the reader arrived with.
  assert.match(
    datasetLandingPath("babynames", { dashboards: [{ name: "x" }], hasQuestions: false }),
    /^\/datasets\/babynames\//,
  );
});

test("refs and dashboard names are URL-encoded", () => {
  const path = datasetLandingPath("a b", {
    dashboards: [{ name: "c d" }],
    hasQuestions: false,
  });
  assert.equal(path, "/datasets/a%20b/dashboard/c%20d");
  // Encoded values must survive the source param too.
  assert.match(
    datasetLandingPath("x", {
      dashboards: [],
      hasQuestions: false,
      firstSource: "order items",
    }),
    /source=order\+items|source=order%20items/,
  );
});
