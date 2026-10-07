import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emitMalloy,
  emptyStage,
  filterLiteral,
  outputNames,
  isRunnable,
  type ExplorerState,
} from "../src/frame-runtime/explore-emit.js";

const f = (...path: string[]) => ({ path });

test("group by + measure + filter + order + limit", () => {
  const st: ExplorerState = {
    source: "orders",
    stage: {
      ...emptyStage(),
      groupBy: [{ id: "1", field: f("state") }],
      aggregates: [{ id: "2", kind: "measure", field: f("total_dollars") }],
      filters: [{ id: "3", field: f("ordered_on"), type: "date", text: "last week" }],
      orderBy: [{ id: "4", name: "total_dollars", dir: "desc" }],
      limit: 10,
    },
  };
  assert.equal(
    emitMalloy(st),
    [
      "run: orders -> {",
      "  where:",
      "    ordered_on ~ f'last week'",
      "  group_by:",
      "    state",
      "  aggregate:",
      "    total_dollars",
      "  order_by: total_dollars desc",
      "  limit: 10",
      "}",
    ].join("\n"),
  );
  assert.ok(isRunnable(st));
});

test("join paths, truncation, inline aggregate, count, rename, collision", () => {
  const st: ExplorerState = {
    source: "orders",
    stage: {
      ...emptyStage(),
      groupBy: [
        { id: "1", field: f("st", "region") },
        { id: "2", field: f("ordered_on"), truncation: "month" },
        { id: "3", field: f("st", "state_name"), as: "State Name" },
        { id: "4", field: f("state") },
        { id: "5", field: { path: ["st", "state"] } }, // collides with `state`
      ],
      aggregates: [
        { id: "6", kind: "agg", field: f("amount"), fn: "sum" },
        { id: "7", kind: "count" },
      ],
    },
  };
  assert.equal(
    emitMalloy(st),
    [
      "run: orders -> {",
      "  group_by:",
      "    st.region",
      "    ordered_on.month",
      "    State_Name is st.state_name",
      "    state",
      "    st_state is st.state",
      "  aggregate:",
      "    amount_sum is amount.sum()",
      "    row_count is count()",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(outputNames(st.stage).groupBy, ["region", "ordered_on", "State_Name", "state", "st_state"]);
});

test("nest, having, viz tags, starting view", () => {
  const st: ExplorerState = {
    source: "orders",
    stage: {
      ...emptyStage(),
      view: "top_categories",
      viz: "bar_chart",
      filters: [{ id: "h", field: f("total_dollars"), type: "number", text: "> 100", measure: true }],
      nests: [
        {
          id: "n",
          name: "by month",
          stage: {
            ...emptyStage(),
            viz: "line_chart",
            groupBy: [{ id: "a", field: f("ordered_on"), truncation: "month" }],
            aggregates: [{ id: "b", kind: "measure", field: f("order_count") }],
          },
        },
        { id: "n2", name: "trend", stage: { ...emptyStage(), view: "by_month" } },
      ],
    },
  };
  assert.equal(
    emitMalloy(st),
    [
      "# bar_chart",
      "run: orders -> top_categories + {",
      "  # line_chart",
      "  nest: by_month is {",
      "    group_by:",
      "      ordered_on.month",
      "    aggregate:",
      "      order_count",
      "  }",
      "  nest: trend is by_month",
      "  having:",
      "    total_dollars ~ f'> 100'",
      "}",
    ].join("\n"),
  );
});

test("a bare view runs as-is; quoting and filter escaping", () => {
  assert.equal(
    emitMalloy({ source: "my source", stage: { ...emptyStage(), view: "by_month" } }),
    "run: `my source` -> by_month",
  );
  assert.equal(filterLiteral("O'Brien, D\\x"), "f'O\\'Brien, D\\\\x'");
  const st: ExplorerState = {
    source: "orders",
    stage: { ...emptyStage(), groupBy: [{ id: "1", field: { path: ["year"], quote: [true] } }] },
  };
  assert.equal(emitMalloy(st), "run: orders -> {\n  group_by:\n    `year`\n}");
});

test("a $GIVEN filter applies the given itself", () => {
  const st: ExplorerState = {
    source: "orders",
    stage: { ...emptyStage(), groupBy: [{ id: "1", field: f("state") }], filters: [{ id: "2", field: f("state"), type: "string", text: "$STATE" }] },
  };
  assert.equal(emitMalloy(st), "run: orders -> {\n  where:\n    state ~ $STATE\n  group_by:\n    state\n}");
});

test("stale order_by is dropped; empty nests are skipped; view keeps order_by", () => {
  const stale: ExplorerState = {
    source: "orders",
    stage: { ...emptyStage(), aggregates: [{ id: "1", kind: "measure", field: f("order_count") }], orderBy: [{ id: "o", name: "state", dir: "desc" }], nests: [{ id: "n", name: "nest_1", stage: emptyStage() }] },
  };
  assert.equal(emitMalloy(stale), "run: orders -> {\n  aggregate:\n    order_count\n}");
  const viewed: ExplorerState = { source: "orders", stage: { ...emptyStage(), view: "top_categories", orderBy: [{ id: "o", name: "total_dollars", dir: "desc" }], limit: 3 } };
  assert.equal(emitMalloy(viewed), "run: orders -> top_categories + {\n  order_by: total_dollars desc\n  limit: 3\n}");
});
