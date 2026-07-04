// @ts-nocheck
// A dashboard artifact. Authored in the repo, alongside the Malloy model.
//
// It receives everything it needs as props from the host runtime — it never
// imports data libraries, holds credentials, or runs its own queries:
//   manifest  — this dashboard's manifest.json
//   givens    — current filter values, e.g. { STATE: "CA", DECADE: 1980 }
//   setGiven  — (name, value) => void, to change a filter
//   Panel     — runs manifest.query (or a named query) with the givens and
//               renders the result with Malloy's renderer
//
// Everything else is your own React: layout, controls, styling.
import React from "react";

export default function Dashboard({ manifest, givens, setGiven, Panel }) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 780, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>{manifest.title}</h1>
      <p style={{ color: "#666", margin: "0 0 16px" }}>
        Share of a name&rsquo;s births that happened in the selected state — higher means more
        concentrated there. Change the filters to re-run the query.
      </p>

      <div style={{ display: "flex", gap: 20, marginBottom: 20 }}>
        {manifest.givens.map((g) => (
          <label key={g.name} style={{ fontSize: 13 }}>
            <div style={{ color: "#888", marginBottom: 4 }}>{g.label ?? g.name}</div>
            <select
              value={givens[g.name]}
              onChange={(e) =>
                setGiven(g.name, g.type === "number" ? Number(e.target.value) : e.target.value)
              }
              style={{ fontSize: 14, padding: "4px 8px" }}
            >
              {g.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <Panel givens={givens} />
    </div>
  );
}
