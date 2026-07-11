// @ts-nocheck
// A dashboard drawn with <VegaChart> — a Vega-Lite spec rendered against Malloy
// query rows. The chart engine ships once in the runtime, so this file adds NO
// chart code: it declares a plain Vega-Lite spec and points its encodings at the
// query's output columns (name, births). The spec's own `data` is supplied by
// the runtime from the query — any remote `data.url` would be stripped, since
// the sandboxed frame has no network. See the model's `births_by_name` view.
import React from "react";
import { Controls, Given, Select, VegaChart } from "@malloyyo/dashboard";

const spec = {
  mark: { type: "bar", tooltip: true, cornerRadiusEnd: 3 },
  encoding: {
    y: { field: "name", type: "nominal", sort: "-x", title: null },
    x: { field: "births", type: "quantitative", title: "Births" },
    color: { field: "name", type: "nominal", legend: null },
  },
  height: { step: 30 },
};

const DECADE_CHOICES = [
  { value: "1980", text: "1980s" },
  { value: "1990", text: "1990s" },
  { value: "[1980 to 1990]", text: "both" },
];

export default function Dashboard({ dashboard, givens }) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>{dashboard.title}</h1>
      <p style={{ color: "#666", margin: "0 0 16px" }}>
        Total births per name for the selected state and decades — change the filters to re-run.
      </p>

      <Controls>
        <Given name="STATE" />
        <Select given="DECADES" options={DECADE_CHOICES} />
      </Controls>

      {/* Runs `run: names -> births_by_name` as a restricted query; rows are
          inlined into the spec as its dataset. */}
      <VegaChart spec={spec} malloy="names -> births_by_name" givens={givens} />
    </div>
  );
}
