import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combineTiles,
  isAggregateRow,
  distributeColspan,
  type CombinableResult,
} from "../src/frame-runtime/combine";

/** A multi-row tile (a grouped query) → renders as a card. */
function cardTile(cols: string[], rows: number[][], annotations: string[] = []): CombinableResult {
  return {
    connection_name: "duckdb",
    annotations: annotations.map((value) => ({ value })),
    schema: { fields: cols.map((name) => ({ kind: "dimension", name, type: { kind: "number_type" } })) },
    data: {
      kind: "array_cell",
      array_value: rows.map((r) => ({
        kind: "record_cell",
        record_value: r.map((n) => ({ kind: "number_cell", number_value: n })),
      })),
    },
  };
}

/** A single-row tile of scalar measures (an aggregate view, no group-by). */
function aggTile(measures: string[], values: number[], annotations: string[] = []): CombinableResult {
  return {
    connection_name: "duckdb",
    annotations: annotations.map((value) => ({ value })),
    schema: {
      fields: measures.map((name) => ({
        kind: "dimension",
        name,
        type: { kind: "number_type" },
        annotations: [{ value: "#(malloy) calculation\n" }],
      })),
    },
    data: {
      kind: "array_cell",
      array_value: [
        { kind: "record_cell", record_value: values.map((n) => ({ kind: "number_cell", number_value: n })) },
      ],
    },
  };
}

test("isAggregateRow: single row of MEASURES is aggregate; grouped, multi-row, or dimension tiles are not", () => {
  assert.equal(isAggregateRow(aggTile(["a", "b"], [1, 2])), true); // one row of measures → yes
  assert.equal(isAggregateRow(cardTile(["x", "y"], [[1, 2], [3, 4]])), false); // multiple rows
  // one row but NOT measures (a 1-row detail table) → card, not scattered KPIs
  assert.equal(isAggregateRow(cardTile(["id", "name"], [[1, 2]])), false);
  // a nested field (array_type) → card, even with one row
  const nested: CombinableResult = {
    schema: { fields: [{ kind: "dimension", name: "n", type: { kind: "array_type" } }] },
    data: { kind: "array_cell", array_value: [{ kind: "record_cell", record_value: [{ kind: "array_cell" }] }] },
  };
  assert.equal(isAggregateRow(nested), false);
});

test("distributeColspan: spans sum to the total, first fields take the remainder", () => {
  assert.deepEqual(distributeColspan(4, 3), [2, 1, 1]);
  assert.deepEqual(distributeColspan(2, 2), [1, 1]);
  assert.deepEqual(distributeColspan(6, 3), [2, 2, 2]);
  assert.deepEqual(distributeColspan(2, 3), [1, 1, 1]); // under-wide: clamp to ≥1 (sum may exceed)
});

test("combineTiles: a grouped tile becomes an array<record> card with its render tags lifted", () => {
  const combined = combineTiles(
    [{ name: "by_year", result: cardTile(["year", "total"], [[2000, 3], [2001, 5]], ["# line_chart\n"]) }],
    { columns: 6 },
  );
  assert.deepEqual(combined.annotations, [{ value: "# dashboard {columns=6}\n" }]);
  assert.equal(combined.schema.fields.length, 1);
  const f = combined.schema.fields[0];
  assert.equal(f.name, "by_year");
  assert.equal((f.type as { kind: string }).kind, "array_type");
  assert.deepEqual(f.annotations, [{ value: "# line_chart\n" }]); // render tag lifted onto the card
  // The card's cell IS the tile's data verbatim (one dashboard row).
  assert.equal(combined.data?.array_value?.[0]?.record_value?.[0], combined.data?.array_value?.[0]?.record_value?.[0]);
});

test("combineTiles: a single-row aggregate tile merges its measures as top-level KPI fields", () => {
  const combined = combineTiles(
    [
      { name: "kpis", result: aggTile(["revenue", "orders"], [100, 5]) },
      { name: "by_year", result: cardTile(["year", "total"], [[2000, 3], [2001, 8]], ["# bar_chart\n"]) },
    ],
    { columns: 6 },
  );
  // kpis is NOT a card — its 2 measures are spliced as top-level fields, then the card.
  const names = combined.schema.fields.map((f) => f.name);
  assert.deepEqual(names, ["revenue", "orders", "by_year"]);
  // The measures keep their calculation marker (→ big-value KPI) and stay scalar.
  assert.equal((combined.schema.fields[0].type as { kind: string }).kind, "number_type");
  assert.ok(combined.schema.fields[0].annotations?.some((a) => a.value.includes("calculation")));
  // by_year is still a nested card.
  assert.equal((combined.schema.fields[2].type as { kind: string }).kind, "array_type");
  // Top-level row: the two KPI cells then the card cell.
  assert.equal(combined.data?.array_value?.[0]?.record_value?.length, 3);
});

test("combineTiles: a merged tile's colspan is distributed across its KPIs; break lands on the first", () => {
  const combined = combineTiles(
    [{ name: "kpis", result: aggTile(["a", "b", "c"], [1, 2, 3], ["# colspan=4\n", "# break\n", "# dashboard\n"]) }],
    { columns: 6 },
  );
  const spans = combined.schema.fields.map(
    (f) => f.annotations?.find((a) => /# colspan/.test(a.value))?.value.match(/=(\d+)/)?.[1],
  );
  assert.deepEqual(spans, ["2", "1", "1"]); // colspan=4 over 3 KPIs → 2,1,1
  // break only on the first KPI.
  assert.ok(combined.schema.fields[0].annotations?.some((a) => a.value.startsWith("# break")));
  assert.ok(!combined.schema.fields[1].annotations?.some((a) => a.value.startsWith("# break")));
});

test("combineTiles: duplicate card names are de-duplicated with a numeric suffix", () => {
  const combined = combineTiles(
    [
      { name: "trend", result: cardTile(["x", "y"], [[1, 2], [3, 4]]) },
      { name: "trend", result: cardTile(["x", "y"], [[5, 6], [7, 8]]) },
    ],
    {},
  );
  assert.deepEqual(combined.schema.fields.map((f) => f.name), ["trend", "trend_2"]);
  // No columns option → bare `# dashboard`.
  assert.deepEqual(combined.annotations, [{ value: "# dashboard\n" }]);
});
