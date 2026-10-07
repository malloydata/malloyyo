// @ts-nocheck
// The EXPLORER dashboard: a point-and-click query builder over one source.
//
// A dashboard declared `## artifact { explore="<source>" }` has no query of
// its own. The host injects the source's described schema
// (`dashboardInfo().explore = { source, description }` — the same shape the
// explore MCP surface's describe_source produces) and this component draws:
//
//   field tree  |  builder (group by / aggregate / filter / nest / …)  |  result
//
// The BUILDER IS THE STATE; the Malloy text is its output (explore-emit.ts),
// shown read-only so a user learns the language by watching. Nothing here
// understands Malloy beyond spelling: every Run compiles the text under the
// host's restricted runner and the compiler's problems come back onto the
// panel. Filters are plain text boxes holding filter-expression source
// (`last week`, `CA, NY`, `> 100`); a text that doesn't parse is flagged, and
// a host that offers `writeFilter` (an LLM that knows the filter language) can
// turn a description into one — see FilterBox.
//
// Runtime code, mounted in the TRUSTED page (like DefaultDashboard): it needs
// the Malloy renderer for results, which sandboxed custom dashboards don't get.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dashboardInfo, givenSpecs, filters, runData, Panel, hostWriteFilter, useDashboard } from "./runtime";
import { Controls } from "./ui";
import {
  emitMalloy,
  emptyStage,
  hasBody,
  isRunnable,
  outputNames,
  refText,
  refLeaf,
  GIVEN_REF_RE,
} from "./explore-emit";

const V = (name, fallback) => `var(--dash-${name}, ${fallback})`;

let idSeq = 1;
const nextId = () => `e${idSeq++}`;

const TRUNCATIONS = {
  date: ["day", "week", "month", "quarter", "year"],
  timestamp: ["second", "minute", "hour", "day", "week", "month", "quarter", "year"],
  timestamptz: ["second", "minute", "hour", "day", "week", "month", "quarter", "year"],
};
const DEFAULT_TRUNCATION = { date: "month", timestamp: "day", timestamptz: "day" };
const AGG_FNS = ["sum", "avg", "min", "max"];
const VIZ_OPTIONS = [
  ["", "Table"],
  ["bar_chart", "Bar chart"],
  ["line_chart", "Line chart"],
  ["scatter_chart", "Scatter"],
  ["shape_map", "Shape map"],
  ["point_map", "Point map"],
  ["list", "List"],
  ["list_detail", "List detail"],
  ["dashboard", "Dashboard"],
];
const FILTER_HINT = {
  string: "CA, NY · Ann% · -TX · empty · $GIVEN",
  number: "> 100 · [10 to 20] · != 0",
  date: "last week · 2025 · 2025-01-01 to 2025-06-30 · 7 days",
  timestamp: "last week · today · 2025-Q2 · 30 days",
  timestamptz: "last week · today · 2025-Q2 · 30 days",
  boolean: "true · false · null · -null",
};

// ── schema → field tree ──────────────────────────────────────────────
// ExploreDescription: { requested, sources: { name: { dimensions{}, measures{},
// views{}, joins{} } } }. A join's target is `source_ref` (look it up) or inline
// `fields`. Walked lazily per join so a deep graph costs nothing until opened.
function groupsOf(desc, join) {
  if (join.source_ref && desc.sources[join.source_ref]) return desc.sources[join.source_ref];
  if (join.fields) return join.fields;
  return { dimensions: {}, measures: {}, views: {}, joins: {} };
}

function fieldNodes(desc, groups, path, fansOut, pathQuote = []) {
  const dims = Object.entries(groups.dimensions || {}).map(([name, f]) => ({
    kind: "dimension",
    name,
    type: f.type,
    path: [...path, name],
    quote: [...pathQuote, !!f.must_quote],
    description: f.description,
    hidden: hasNoUi(f),
  }));
  const measures = Object.entries(groups.measures || {}).map(([name, f]) => ({
    kind: "measure",
    name,
    type: f.type,
    expression: f.expression,
    path: [...path, name],
    quote: [...pathQuote, !!f.must_quote],
    description: f.description,
    hidden: hasNoUi(f),
  }));
  const joins = Object.entries(groups.joins || {}).map(([name, j]) => ({
    kind: "join",
    name,
    relationship: j.relationship,
    column_shape: j.column_shape,
    fansOut: fansOut || j.relationship === "one_to_many" || j.relationship === "cross",
    path: [...path, name],
    pathQuote: [...pathQuote, !!j.must_quote],
    join: j,
    description: j.description,
  }));
  return { dims: dims.filter((d) => !d.hidden), measures: measures.filter((m) => !m.hidden), joins };
}

const hasNoUi = (f) => (f.annotations || []).some((a) => /^#\s*NO_UI\b/i.test(a.text || "") || a.text === "NO_UI");

// ── state helpers (immutable, by nest path) ──────────────────────────
// A "stage path" is the list of nest ids from the root stage to a nested one.
function updateStage(stage, nestPath, fn) {
  if (nestPath.length === 0) return fn(stage);
  const [head, ...rest] = nestPath;
  return {
    ...stage,
    nests: stage.nests.map((n) => (n.id === head ? { ...n, stage: updateStage(n.stage, rest, fn) } : n)),
  };
}
function stageAt(stage, nestPath) {
  let s = stage;
  for (const id of nestPath) {
    const n = s.nests.find((x) => x.id === id);
    if (!n) return stage;
    s = n.stage;
  }
  return s;
}
const samePath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── small styled bits ───────────────────────────────────────────────
const panelStyle = {
  background: V("control-bg", "#fff"),
  border: `1px solid ${V("border", "#e5e7eb")}`,
  borderRadius: V("radius", "8px"),
  minHeight: 0,
};
const headStyle = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: V("muted", "#6b7280"),
  padding: "8px 10px 4px",
};
const tokenStyle = (accent) => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 6px 3px 8px",
  borderRadius: 6,
  background: accent ? V("chip-bg", "#eef2ff") : V("controls-bg", "#f9fafb"),
  color: accent ? V("chip-fg", "#3730a3") : V("fg", "#171717"),
  fontSize: 13,
  lineHeight: 1.4,
  minWidth: 0,
});
const xStyle = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 15,
  lineHeight: 1,
  padding: "0 2px",
  opacity: 0.6,
  marginLeft: "auto",
};
const miniSelect = {
  fontSize: 12,
  padding: "1px 4px",
  borderRadius: 4,
  border: `1px solid ${V("border", "#d1d5db")}`,
  background: V("control-bg", "#fff"),
  color: V("fg", "#171717"),
};
const miniInput = { ...miniSelect, padding: "2px 6px", minWidth: 60 };
const btn = (primary, enabled = true) => ({
  fontSize: 13,
  padding: "5px 12px",
  borderRadius: 6,
  cursor: enabled ? "pointer" : "default",
  opacity: enabled ? 1 : 0.5,
  background: primary ? V("accent", "#2563eb") : V("control-bg", "#fff"),
  color: primary ? V("accent-fg", "#fff") : V("fg", "#171717"),
  border: primary ? "1px solid transparent" : `1px solid ${V("border", "#d1d5db")}`,
});
const linkBtn = {
  border: "none",
  background: "transparent",
  color: V("accent", "#2563eb"),
  cursor: "pointer",
  fontSize: 12,
  padding: "2px 6px",
  borderRadius: 4,
};

function TypeGlyph({ type, kind }) {
  const glyph =
    kind === "measure" ? "Σ" : kind === "join" ? "⇢" : kind === "view" ? "▤"
    : type === "string" ? "Aa" : type === "number" ? "#" : type === "boolean" ? "✓"
    : type === "date" || type === "timestamp" || type === "timestamptz" ? "⏱" : "·";
  return (
    <span style={{ display: "inline-block", width: 18, textAlign: "center", fontSize: 11, color: V("muted", "#6b7280") }}>
      {glyph}
    </span>
  );
}

// ── field tree ──────────────────────────────────────────────────────
function FieldRow({ node, actions }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      title={node.description || (node.expression ? `${node.name} is ${node.expression}` : node.path.join("."))}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "2px 6px",
        borderRadius: 4,
        background: hover ? V("controls-bg", "#f3f4f6") : "transparent",
        fontSize: 13,
        cursor: "default",
      }}
    >
      <TypeGlyph type={node.type} kind={node.kind} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{node.name}</span>
      {hover && (
        <span style={{ display: "flex", gap: 2 }}>
          {actions.map(([label, title, fn]) => (
            <button key={label} type="button" title={title} onClick={fn} style={linkBtn}>
              {label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function JoinGroup({ desc, node, depth, onAction }) {
  const [open, setOpen] = useState(depth < 1);
  const groups = useMemo(() => fieldNodes(desc, groupsOf(desc, node.join), node.path, node.fansOut, node.pathQuote), [desc, node]);
  const rel =
    node.column_shape === "record" ? "record"
    : node.column_shape ? "array"
    : node.relationship === "many_to_one" ? "one" : node.relationship === "one_to_many" ? "many" : "cross";
  return (
    <div style={{ marginLeft: depth ? 10 : 0 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
      >
        <span style={{ width: 10, fontSize: 10, color: V("muted", "#6b7280") }}>{open ? "▾" : "▸"}</span>
        <TypeGlyph kind="join" />
        <span>{node.name}</span>
        <span style={{ fontSize: 10, color: V("muted", "#6b7280"), fontWeight: 400 }}>
          {rel}
          {node.fansOut ? " · fans out" : ""}
        </span>
      </div>
      {open && depth < 4 && (
        <div style={{ marginLeft: 12 }}>
          <FieldList desc={desc} groups={groups} depth={depth + 1} onAction={onAction} />
        </div>
      )}
    </div>
  );
}

function FieldList({ desc, groups, depth, onAction, views }) {
  return (
    <>
      {groups.dims.map((d) => (
        <FieldRow
          key={d.path.join(".")}
          node={d}
          actions={[
            ["group", "Group by this dimension", () => onAction("group_by", d)],
            ["filter", "Filter on this dimension", () => onAction("filter", d)],
            ...(d.type === "number" ? [["Σ", "Aggregate this number (sum / avg / …)", () => onAction("agg", d)]] : []),
          ]}
        />
      ))}
      {groups.measures.map((m) => (
        <FieldRow
          key={m.path.join(".")}
          node={m}
          actions={[
            ["show", "Show this measure", () => onAction("aggregate", m)],
            ["having", "Filter groups by this measure", () => onAction("having", m)],
          ]}
        />
      ))}
      {views &&
        views.map((v) => (
          <FieldRow
            key={`view:${v.name}`}
            node={v}
            actions={[
              ["start", "Start from this view", () => onAction("view", v)],
              ["nest", "Add as a nested query", () => onAction("nest_view", v)],
            ]}
          />
        ))}
      {groups.joins.map((j) => (
        <JoinGroup key={j.path.join(".")} desc={desc} node={j} depth={depth} onAction={onAction} />
      ))}
    </>
  );
}

// ── filter box ──────────────────────────────────────────────────────
// One text box; the text IS the filter expression. Tier 1: if it parses for
// the field's type, it's used as-is. Tier 2 (hosts that offer it): a
// description that doesn't parse can be handed to the host's writeFilter —
// an LLM that knows the filter sub-language — and the returned expression
// lands in the same box, editable. Both tiers end in text the user can see.
function FilterBox({ filter, source, desc, onChange, onRemove }) {
  const [draft, setDraft] = useState(filter.text);
  useEffect(() => setDraft(filter.text), [filter.text]);
  const type = filter.type;
  const empty = draft.trim() === "";
  const isGivenRef = GIVEN_REF_RE.test(draft.trim());
  const valid = empty || isGivenRef || type === "boolean" || filters.isValid(type, draft);
  const commit = () => {
    if (draft !== filter.text) onChange({ ...filter, text: draft });
  };
  const [opts, setOpts] = useState([]);
  // Typeahead for string dimensions: distinct values, prefix-filtered server
  // side (same shape the given `suggest` typeahead uses). Only the last
  // comma-separated token is matched so `CA, N` suggests NY.
  const lastTerm = draft.split(",").pop().trim();
  useEffect(() => {
    if (type !== "string" || filter.measure) return;
    let cancelled = false;
    const t = setTimeout(() => {
      const field = refText(filter.field);
      const esc = filters.startsWith(lastTerm.toLowerCase()).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const q = lastTerm
        ? `${source} -> { group_by: ${field}; where: lower(${field}) ~ f'${esc}'; limit: 30 }`
        : `${source} -> { group_by: ${field}; limit: 30 }`;
      runData(q, {})
        .then((rows) => !cancelled && setOpts(rows.map((r) => Object.values(r)[0]).filter((v) => v != null)))
        .catch(() => !cancelled && setOpts([]));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [lastTerm, type, source, filter.measure]);
  const listId = `explore-opts-${filter.id}`;
  // Tier 2: the host's model writes the expression from the description. Only
  // offered when the text does NOT parse (a parsing text is already the filter)
  // and the host has the capability. What comes back lands in the same box,
  // committed, with the model's one-line note under it — the user sees exactly
  // what will run and can edit it.
  const writeFilter = hostWriteFilter();
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState(null);
  const askModel = () => {
    if (!writeFilter || writing || empty) return;
    setWriting(true);
    setNote(null);
    writeFilter({
      field: refText(filter.field),
      type,
      description: draft,
      values: type === "string" ? opts.map(String) : undefined,
      source,
    })
      .then((r) => {
        if (r && r.ok) {
          setDraft(r.text);
          onChange({ ...filter, text: r.text });
          setNote(r.note ? { ok: true, text: r.note } : null);
        } else {
          setNote({ ok: false, text: (r && (r.error || r.note)) || "no filter written" });
        }
      })
      .catch((e) => setNote({ ok: false, text: String(e) }))
      .finally(() => setWriting(false));
  };
  return (
    <div style={{ ...tokenStyle(false), flexDirection: "column", alignItems: "stretch", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 600 }}>{refText(filter.field)}</span>
        <span style={{ fontSize: 11, color: V("muted", "#6b7280") }}>{filter.measure ? "having" : type}</span>
        <button type="button" onClick={onRemove} style={xStyle} aria-label="Remove filter">
          ×
        </button>
      </div>
      <input
        list={type === "string" ? listId : undefined}
        value={draft}
        placeholder={FILTER_HINT[type] || "filter expression"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        style={{
          ...miniInput,
          width: "100%",
          boxSizing: "border-box",
          fontSize: 13,
          padding: "4px 6px",
          border: `1px solid ${valid ? V("border", "#d1d5db") : V("danger", "#dc2626")}`,
        }}
      />
      {type === "string" && (
        <datalist id={listId}>
          {opts.map((o) => (
            <option key={String(o)} value={String(o)} />
          ))}
        </datalist>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, minHeight: 12 }}>
        <span style={{ color: !valid ? V("danger", "#dc2626") : V("muted", "#6b7280"), flex: 1 }}>
          {note
            ? note.text
            : !valid
              ? writeFilter
                ? "Not a filter expression yet — ✨ writes one from what you typed"
                : "Not a filter expression — rephrase, or press Run to see the compiler's view"
              : draft !== filter.text
                ? "↵ to apply"
                : " "}
        </span>
        {writeFilter && !empty && (type === "string" || !valid) && (
          <button type="button" onClick={askModel} disabled={writing} style={{ ...linkBtn, fontSize: 11 }} title="Have the model write the filter expression from what you typed">
            {writing ? "writing…" : "✨ write it"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── one stage's builder ─────────────────────────────────────────────
function StageEditor({ stage, nestPath, focused, setFocus, update, source, desc, depth }) {
  const names = outputNames(stage);
  const isRoot = nestPath.length === 0;
  const set = (fn) => update(nestPath, fn);
  const outputs = [...names.groupBy, ...names.aggregates];
  const views = desc.sources[source]?.views || {};
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        setFocus(nestPath);
      }}
      style={{
        border: `1px solid ${focused ? V("accent", "#2563eb") : V("border", "#e5e7eb")}`,
        borderRadius: 8,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: depth % 2 ? V("controls-bg", "#f9fafb") : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: V("muted", "#6b7280") }}>
        <span style={{ fontWeight: 600, color: V("fg", "#171717") }}>
          {isRoot ? source : "nest"}
        </span>
        <span>→</span>
        <select
          value={stage.view || ""}
          onChange={(e) => set((s) => ({ ...s, view: e.target.value || undefined }))}
          style={miniSelect}
          title="Start from a named view of the source"
        >
          <option value="">{"{ … }"}</option>
          {Object.keys(views).map((v) => (
            <option key={v} value={v}>
              {v} + {"{ … }"}
            </option>
          ))}
        </select>
        <span style={{ marginLeft: "auto" }} />
        <select
          value={stage.viz || ""}
          onChange={(e) => set((s) => ({ ...s, viz: e.target.value || undefined }))}
          style={miniSelect}
          title="How to render this result"
        >
          {VIZ_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {focused && <span title="Field clicks land here" style={{ fontSize: 10, color: V("accent", "#2563eb") }}>●</span>}
      </div>

      {stage.groupBy.length > 0 && (
        <Section label="group by">
          {stage.groupBy.map((g, i) => (
            <div key={g.id} style={tokenStyle(false)}>
              <span>{refText(g.field)}</span>
              {g.truncation && (
                <select
                  value={g.truncation}
                  onChange={(e) =>
                    set((s) => ({ ...s, groupBy: s.groupBy.map((x) => (x.id === g.id ? { ...x, truncation: e.target.value } : x)) }))
                  }
                  style={miniSelect}
                >
                  {(TRUNCATIONS[g.type] || TRUNCATIONS.timestamp).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              <RenameBtn
                current={names.groupBy[i]}
                onRename={(as) => set((s) => ({ ...s, groupBy: s.groupBy.map((x) => (x.id === g.id ? { ...x, as } : x)) }))}
              />
              <button type="button" style={xStyle} onClick={() => set((s) => ({ ...s, groupBy: s.groupBy.filter((x) => x.id !== g.id) }))}>
                ×
              </button>
            </div>
          ))}
        </Section>
      )}

      {stage.aggregates.length > 0 && (
        <Section label="aggregate">
          {stage.aggregates.map((a, i) => (
            <div key={a.id} style={tokenStyle(true)}>
              {a.kind === "measure" && <span>{refText(a.field)}</span>}
              {a.kind === "count" && <span>count()</span>}
              {a.kind === "agg" && (
                <>
                  <span>{refText(a.field)}.</span>
                  <select
                    value={a.fn}
                    onChange={(e) =>
                      set((s) => ({ ...s, aggregates: s.aggregates.map((x) => (x.id === a.id ? { ...x, fn: e.target.value } : x)) }))
                    }
                    style={miniSelect}
                  >
                    {AGG_FNS.map((fn) => (
                      <option key={fn} value={fn}>
                        {fn}()
                      </option>
                    ))}
                  </select>
                </>
              )}
              <RenameBtn
                current={names.aggregates[i]}
                onRename={(as) => set((s) => ({ ...s, aggregates: s.aggregates.map((x) => (x.id === a.id ? { ...x, as } : x)) }))}
              />
              <button type="button" style={xStyle} onClick={() => set((s) => ({ ...s, aggregates: s.aggregates.filter((x) => x.id !== a.id) }))}>
                ×
              </button>
            </div>
          ))}
        </Section>
      )}

      {stage.filters.length > 0 && (
        <Section label="filter">
          {stage.filters.map((f) => (
            <FilterBox
              key={f.id}
              filter={f}
              source={source}
              desc={desc}
              onChange={(nf) => set((s) => ({ ...s, filters: s.filters.map((x) => (x.id === f.id ? nf : x)) }))}
              onRemove={() => set((s) => ({ ...s, filters: s.filters.filter((x) => x.id !== f.id) }))}
            />
          ))}
        </Section>
      )}

      {stage.nests.length > 0 && (
        <Section label="nest">
          {stage.nests.map((n, i) => (
            <div key={n.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  value={n.name}
                  onChange={(e) => set((s) => ({ ...s, nests: s.nests.map((x) => (x.id === n.id ? { ...x, name: e.target.value } : x)) }))}
                  style={{ ...miniInput, fontWeight: 600 }}
                />
                <span style={{ color: V("muted", "#6b7280") }}>
                  → {names.nests[i]}
                  {!n.stage.view && n.stage.groupBy.length === 0 && n.stage.aggregates.length === 0 ? " (empty — not run)" : ""}
                </span>
                <button type="button" style={{ ...xStyle, marginLeft: "auto" }} onClick={() => set((s) => ({ ...s, nests: s.nests.filter((x) => x.id !== n.id) }))}>
                  ×
                </button>
              </div>
              <StageEditor
                stage={n.stage}
                nestPath={[...nestPath, n.id]}
                focused={focused === false ? false : focusedIs(focused, [...nestPath, n.id])}
                setFocus={setFocus}
                update={update}
                source={source}
                desc={desc}
                depth={depth + 1}
              />
            </div>
          ))}
        </Section>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: V("muted", "#6b7280") }}>order by</span>
          {/* A combobox, not a select: with a starting view the legal names
              include the view's own outputs, which the builder can't list —
              type one; the compiler checks it. */}
          <input
            list={`explore-outputs-${nestPath.join("-") || "root"}`}
            value={stage.orderBy[0]?.name || ""}
            placeholder={stage.view ? "an output of the view…" : "(default)"}
            onChange={(e) =>
              set((s) => ({
                ...s,
                orderBy: e.target.value.trim()
                  ? [{ id: s.orderBy[0]?.id || nextId(), name: e.target.value.trim(), dir: s.orderBy[0]?.dir || "desc" }]
                  : [],
              }))
            }
            style={{ ...miniInput, width: 130 }}
          />
          <datalist id={`explore-outputs-${nestPath.join("-") || "root"}`}>
            {outputs.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          {stage.orderBy[0] && (
            <select
              value={stage.orderBy[0].dir || "asc"}
              onChange={(e) => set((s) => ({ ...s, orderBy: [{ ...s.orderBy[0], dir: e.target.value }] }))}
              style={miniSelect}
            >
              <option value="asc">asc</option>
              <option value="desc">desc</option>
            </select>
          )}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: V("muted", "#6b7280") }}>limit</span>
          <input
            type="number"
            min={1}
            value={stage.limit ?? ""}
            placeholder="all"
            onChange={(e) => set((s) => ({ ...s, limit: e.target.value === "" ? undefined : Number(e.target.value) }))}
            style={{ ...miniInput, width: 64 }}
          />
        </label>
        <button
          type="button"
          style={linkBtn}
          title="Add a nested query (one sub-table per row of this stage)"
          onClick={() => set((s) => ({ ...s, nests: [...s.nests, { id: nextId(), name: `nest_${s.nests.length + 1}`, stage: emptyStage() }] }))}
        >
          + nest
        </button>
        <button
          type="button"
          style={linkBtn}
          title="Add a row count"
          onClick={() => set((s) => ({ ...s, aggregates: [...s.aggregates, { id: nextId(), kind: "count" }] }))}
        >
          + count()
        </button>
      </div>
    </div>
  );
}

const focusedIs = (focus, path) => samePath(focus, path);

function Section({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: V("muted", "#6b7280") }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function RenameBtn({ current, onRename }) {
  return (
    <button
      type="button"
      title={`Output name: ${current}. Click to rename.`}
      style={{ ...linkBtn, color: V("muted", "#6b7280"), fontSize: 11 }}
      onClick={() => {
        const v = window.prompt("Output name", current);
        if (v != null && v.trim()) onRename(v.trim());
      }}
    >
      as {current}
    </button>
  );
}

// ── the dashboard ───────────────────────────────────────────────────
// The model's givens, as the dashboard runtime already knows them: every
// `given:` in the dashboard file's scope, drawn with the same controls a
// tag-only dashboard gets. Values are the runtime's committed givens and ride
// with every Run (unreferenced ones are harmless; a `$NAME` the query names
// takes the value shown). Collapsible, above the fields — "what will this run
// with?" answered before pressing Run.
function GivensSection() {
  const specs = givenSpecs();
  const { givens } = useDashboard();
  const [open, setOpen] = useState(true);
  if (!specs.length) return null;
  const summary = specs
    .map((s) => `${s.tags?.label ?? s.name}=${givens[s.name] === undefined || givens[s.name] === "" ? "all" : givens[s.name]}`)
    .join(" · ");
  return (
    <div style={{ borderBottom: `1px solid ${V("border", "#e5e7eb")}` }}>
      <div onClick={() => setOpen(!open)} style={{ ...headStyle, cursor: "pointer", display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ width: 10, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        <span>givens</span>
        {!open && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>}
      </div>
      {open && (
        <div style={{ padding: "0 8px 8px" }}>
          <Controls style={{ flexDirection: "column", padding: 8, marginBottom: 0 }} />
        </div>
      )}
    </div>
  );
}

export function ExplorerDashboard() {
  const info = dashboardInfo();
  const { givens } = useDashboard();
  const explore = info.explore || {};
  const source = explore.source;
  const desc = explore.description;
  const root = desc?.sources?.[source];

  const [state, setState] = useState(() => ({ source, stage: emptyStage() }));
  const [focus, setFocus] = useState([]); // nest path of the stage field actions target
  const [ran, setRan] = useState(null); // { text, n } — what the result panel shows
  const [showMalloy, setShowMalloy] = useState(true);
  const update = useCallback((nestPath, fn) => setState((st) => ({ ...st, stage: updateStage(st.stage, nestPath, fn) })), []);

  const malloy = useMemo(() => emitMalloy(state), [state]);
  const runnable = isRunnable(state);
  const stale = ran && (ran.text !== malloy || JSON.stringify(ran.givens) !== JSON.stringify(givens));

  const run = () => {
    if (!runnable) return;
    setRan({ text: malloy, givens, n: (ran?.n || 0) + 1 });
  };
  // Cmd/Ctrl+Enter runs from anywhere in the page.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onAction = (kind, node) => {
    const target = focus;
    const field = { path: node.path, quote: node.quote };
    if (kind === "group_by") {
      update(target, (s) => ({
        ...s,
        groupBy: [...s.groupBy, { id: nextId(), field, type: node.type, truncation: DEFAULT_TRUNCATION[node.type] }],
      }));
    } else if (kind === "aggregate") {
      update(target, (s) => ({ ...s, aggregates: [...s.aggregates, { id: nextId(), kind: "measure", field }] }));
    } else if (kind === "agg") {
      update(target, (s) => ({ ...s, aggregates: [...s.aggregates, { id: nextId(), kind: "agg", field, fn: "sum" }] }));
    } else if (kind === "filter" || kind === "having") {
      update(target, (s) => ({
        ...s,
        filters: [...s.filters, { id: nextId(), field, type: node.type, text: "", measure: kind === "having" }],
      }));
    } else if (kind === "view") {
      update(target, (s) => ({ ...s, view: node.name }));
    } else if (kind === "nest_view") {
      update(target, (s) => ({ ...s, nests: [...s.nests, { id: nextId(), name: node.name, stage: { ...emptyStage(), view: node.name } }] }));
    }
  };

  if (!desc || !root) {
    return (
      <pre style={{ color: "crimson", padding: 16 }}>
        {`explorer: no schema for source '${source}' — the host must inject dashboardInfo().explore`}
      </pre>
    );
  }
  const groups = fieldNodes(desc, root, [], false);
  const views = Object.entries(root.views || {}).map(([name, v]) => ({ kind: "view", name, description: v?.description, path: [name] }));

  return (
    <div style={{ fontFamily: V("font", "system-ui, sans-serif"), color: V("fg", "#171717"), padding: 16, boxSizing: "border-box", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>{info.title || `Explore ${source}`}</h1>
        {info.description && <span style={{ color: V("muted", "#6b7280"), fontSize: 13 }}>{info.description}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "240px 380px minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
        {/* field tree */}
        <div style={{ ...panelStyle, maxHeight: "calc(100vh - 120px)", overflow: "auto" }}>
          <GivensSection />
          <div style={headStyle}>{source}</div>
          <div style={{ padding: "0 4px 8px" }}>
            <FieldList desc={desc} groups={groups} depth={0} onAction={onAction} views={views} />
          </div>
        </div>

        {/* builder */}
        <div style={{ ...panelStyle, padding: 8, display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 120px)", overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" onClick={run} disabled={!runnable} style={btn(true, runnable)} title="Run (⌘↵)">
              Run
            </button>
            <button
              type="button"
              onClick={() => {
                setState({ source, stage: emptyStage() });
                setFocus([]);
              }}
              style={btn(false)}
            >
              Clear
            </button>
            <span style={{ marginLeft: "auto", fontSize: 11, color: V("muted", "#6b7280") }}>
              {stale ? "changed since last run" : ran ? "up to date" : "click fields on the left"}
            </span>
          </div>
          <StageEditor stage={state.stage} nestPath={[]} focused={focusedIs(focus, [])} setFocus={setFocus} update={update} source={source} desc={desc} depth={0} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={headStyle}>Malloy</div>
            <button type="button" style={linkBtn} onClick={() => setShowMalloy(!showMalloy)}>
              {showMalloy ? "hide" : "show"}
            </button>
            <button
              type="button"
              style={linkBtn}
              onClick={() => navigator.clipboard && navigator.clipboard.writeText(malloy).catch(() => {})}
            >
              copy
            </button>
          </div>
          {showMalloy && (
            <pre
              style={{
                margin: 0,
                padding: 8,
                fontSize: 12,
                lineHeight: 1.4,
                background: V("controls-bg", "#f9fafb"),
                border: `1px solid ${V("border", "#e5e7eb")}`,
                borderRadius: 6,
                whiteSpace: "pre-wrap",
                color: V("fg", "#171717"),
              }}
            >
              {malloy}
            </pre>
          )}
        </div>

        {/* result */}
        <div style={{ minWidth: 0 }}>
          {ran ? (
            // key on the run count: Panel only refetches when its query text
            // changes, and "Run" must re-run even unchanged text.
            <Panel key={ran.n} malloy={ran.text} givens={ran.givens} style={{ maxHeight: "calc(100vh - 120px)", opacity: stale ? 0.7 : 1 }} />
          ) : (
            <div style={{ ...panelStyle, padding: 24, color: V("muted", "#6b7280"), fontSize: 13, minHeight: 200 }}>
              Pick a dimension to group by and a measure to show, then Run.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
