// @ts-nocheck
// A dashboard artifact. The `# artifact` tag on the model's `over_represented`
// query declares this dashboard; the query's given: declarations (with their
// # label / control / suggest tags) declare the filters. This optional
// file only customizes presentation — delete it and the runtime auto-renders
// the same controls + panel as its default dashboard.
//
// It composes the runtime's widgets from "@malloyyo/dashboard" with plain
// React. It never imports data libraries, holds credentials, or builds query
// strings; arbitrary Malloy (Panel malloy=… / runData / useQuery) runs as a
// RESTRICTED query against the model's published surface.
import React from "react";
import { Controls, Given, Select, Panel } from "@malloyyo/dashboard";

const DECADE_CHOICES = [
  { value: "1980", text: "1980s" },
  { value: "1990", text: "1990s" },
  { value: "[1980 to 1990]", text: "both" },
];

export default function Dashboard({ dashboard, givens }) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 780, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>{dashboard.title}</h1>
      <p style={{ color: "#666", margin: "0 0 16px" }}>
        Share of a name&rsquo;s births that happened in the selected state — higher means more
        concentrated there. Change the filters to re-run the query.
      </p>

      <Controls>
        <Given name="STATE" />
        <Select given="DECADES" options={DECADE_CHOICES} />
      </Controls>

      <Panel givens={givens} />
    </div>
  );
}
