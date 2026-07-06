// @ts-nocheck
// Headless-ish widgets bound to the model's givens by name. Each widget reads
// its given's declaration spec (type, tags, default) and commits filter-
// expression values through the shared runtime — a Dashboard.tsx composes them
// with ordinary React and restyles via CSS custom properties or className/style:
//
//   --dash-fg, --dash-muted, --dash-border, --dash-accent, --dash-control-bg
//
// <Given name="X"/> picks the control from the declaration; <Controls/> lays
// out every given the dashboard's query references; <DefaultDashboard/> is the
// whole no-code dashboard (title + controls + panel) used when a tagged query
// ships no Dashboard.tsx.
import React, { useEffect, useState } from "react";
import { dashboardInfo, givenSpecs, filters, useGiven, useOptions, Panel } from "./runtime";

const V = (name, fallback) => `var(--dash-${name}, ${fallback})`;
const label_ = (spec) => spec?.tags?.label ?? spec?.name;

const labelStyle = { color: V("muted", "#888"), marginBottom: 4, fontSize: 13 };
const controlStyle = {
  fontSize: 14,
  padding: "5px 8px",
  borderRadius: 6,
  border: `1px solid ${V("border", "#ccc")}`,
  background: V("control-bg", "white"),
  color: V("fg", "#1a1a1a"),
};

/** Labeled wrapper every control uses; bring your own label with label={null}. */
export function Field({ label, children, style }) {
  return (
    <label style={{ fontSize: 13, ...style }}>
      {label != null && <div style={labelStyle}>{label}</div>}
      {children}
    </label>
  );
}

/** A <select> bound to a given. Options: the `options` prop (strings or
    {value, text}), else the given's `# suggest {…}` tag. Plain suggested options are
    column VALUES — for a filter<T> given they're escaped into an exact-match
    filter expression on commit (a raw 'Tesla, Inc.' would parse as two
    alternatives). Explicit {value, text} options pass through untouched — the
    author already supplies filter sources there. */
export function Select({ given, options, label, style }) {
  const { value, set, spec } = useGiven(given);
  const suggested = useOptions(given);
  const isFilter = !!spec?.filterType;
  const toValue = (o) => (isFilter && o !== "" ? filters.oneOf(String(o)) : String(o));
  const raw = options ?? (suggested.loading ? [value].filter((v) => v != null) : suggested.options);
  const opts = raw.map((o) =>
    typeof o === "object" ? o : { value: toValue(o), text: String(o) },
  );
  if (value != null && !opts.some((o) => o.value === value)) {
    const texts = isFilter ? filters.values(value) : null;
    opts.push({ value, text: texts?.join(", ") ?? String(value) });
  }
  return (
    <Field label={label ?? label_(spec)}>
      <select value={value ?? ""} onChange={(e) => set(e.target.value)} style={{ ...controlStyle, ...style }}>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A committing text input bound to a filter<T> given, with typeahead
    suggestions from the given's `# suggest {…}` tag and filter-syntax validation.
    Users can type filter expressions: `Emma, Olivia`, `Em%`, `-NY`. */
export function Search({ given, label, placeholder, style }) {
  const { value, set, spec } = useGiven(given);
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  // Suggest against the last typed token so `Emma, Ol` suggests Olivia.
  const lastTerm = draft.split(",").pop().trim();
  const { options } = useOptions(given, lastTerm);
  const filterType = spec?.filterType ?? "string";
  const valid = draft.trim() === "" || filters.isValid(filterType, draft);
  const listId = `dash-options-${given}`;
  const commit = (v) => {
    const next = (v ?? draft).trim();
    if (next && filters.isValid(filterType, next) && next !== value) set(next);
  };
  return (
    <Field label={label ?? label_(spec)}>
      <input
        value={draft}
        list={listId}
        placeholder={placeholder ?? spec?.description}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        style={{
          ...controlStyle,
          minWidth: 180,
          border: `1px solid ${valid ? V("border", "#ccc") : "#d33"}`,
          ...style,
        }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </Field>
  );
}

const RANGE_CSS = `
.dash-range { position: relative; width: 240px; height: 34px; }
.dash-range .track { position:absolute; top:15px; left:0; right:0; height:4px; border-radius:2px; background:${V("border", "#d5d8dd")}; }
.dash-range .fill  { position:absolute; top:15px; height:4px; border-radius:2px; background:${V("accent", "#1a1a1a")}; }
.dash-range input[type=range] {
  position:absolute; top:6px; left:0; width:100%; height:22px; margin:0;
  -webkit-appearance:none; appearance:none; background:transparent; pointer-events:none;
}
.dash-range input[type=range]::-webkit-slider-thumb {
  -webkit-appearance:none; appearance:none; pointer-events:auto; cursor:pointer;
  height:18px; width:18px; border-radius:50%; background:${V("control-bg", "#fff")}; border:2px solid ${V("accent", "#1a1a1a")}; box-sizing:border-box;
}
.dash-range input[type=range]::-moz-range-thumb {
  pointer-events:auto; cursor:pointer;
  height:18px; width:18px; border-radius:50%; background:${V("control-bg", "#fff")}; border:2px solid ${V("accent", "#1a1a1a")}; box-sizing:border-box;
}
.dash-range input[type=range]::-moz-range-track { background:transparent; }
`;

/** A dual-thumb slider bound to a filter<number> given holding an inclusive
    range ('[lo to hi]'). Bounds come from min/max props or the declaration's
    range_min/range_max tags. Commits on release, not per drag tick. */
export function Range({ given, min, max, label, step = 1 }) {
  const { value, set, spec } = useGiven(given);
  const lo0 = min ?? spec?.tags?.range_min ?? 0;
  const hi0 = max ?? spec?.tags?.range_max ?? 100;
  const { lo, hi } = filters.numberRange(value ?? "") ?? { lo: lo0, hi: hi0 };
  const [draft, setDraft] = useState([lo, hi]);
  useEffect(() => setDraft([lo, hi]), [lo, hi]);
  const [dLo, dHi] = draft;
  const pct = (v) => ((v - lo0) / (hi0 - lo0)) * 100;
  const commit = () => {
    const next = filters.between(draft[0], draft[1]);
    if (next !== value) set(next);
  };
  const thumb = (v, z, clamp) => (
    <input
      type="range"
      min={lo0}
      max={hi0}
      step={step}
      value={v}
      style={{ zIndex: z }}
      onChange={(e) => setDraft(clamp(Number(e.target.value)))}
      onMouseUp={commit}
      onTouchEnd={commit}
      onKeyUp={commit}
    />
  );
  return (
    <div>
      <style>{RANGE_CSS}</style>
      <div style={labelStyle}>
        {label ?? label_(spec)}:{" "}
        <strong style={{ color: V("fg", "#333") }}>
          {dLo}&ndash;{dHi}
        </strong>
      </div>
      <div className="dash-range">
        <div className="track" />
        <div className="fill" style={{ left: `${pct(dLo)}%`, width: `${pct(dHi) - pct(dLo)}%` }} />
        {/* Keep the low thumb reachable when both sit near the top of the range. */}
        {thumb(dLo, dLo > (lo0 + hi0) / 2 ? 5 : 3, (v) => [Math.min(v, dHi), dHi])}
        {thumb(dHi, 4, (v) => [dLo, Math.max(v, dLo)])}
      </div>
    </div>
  );
}

/** A checkbox bound to a boolean given. */
export function Checkbox({ given, label, style }) {
  const { value, set, spec } = useGiven(given);
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 14,
        color: V("fg", "#374151"),
        cursor: "pointer",
        ...style,
      }}
    >
      <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
      <span>{label ?? label_(spec)}</span>
    </label>
  );
}

/** The right control for a given, picked from its declaration: numeric range
    tags → Range, suggestions + control=select → Select, boolean → Checkbox,
    anything else → Search. */
export function Given({ name, ...rest }) {
  const spec = givenSpecs().find((s) => s.name === name);
  if (!spec) return null;
  const tags = spec.tags ?? {};
  if (spec.filterType === "number" && tags.range_min != null && tags.range_max != null) {
    return <Range given={name} {...rest} />;
  }
  if (spec.suggest && tags.control === "select") return <Select given={name} {...rest} />;
  if (spec.type === "boolean") return <Checkbox given={name} {...rest} />;
  return <Search given={name} {...rest} />;
}

/** Every given the dashboard's query references, laid out in a filter bar. */
export function Controls({ style, children }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 24,
        marginBottom: 20,
        padding: "14px 16px",
        background: V("controls-bg", "#f6f7f9"),
        borderRadius: 8,
        ...style,
      }}
    >
      {children ?? givenSpecs().map((s) => <Given key={s.name} name={s.name} />)}
    </div>
  );
}

/** The whole no-code dashboard: title + doc comment + controls + panel. Used
    when a `# artifact`-tagged query ships no Dashboard.tsx. */
export function DefaultDashboard({ givens }) {
  const dash = dashboardInfo();
  return (
    <div
      style={{
        fontFamily: V("font", "system-ui, sans-serif"),
        padding: 24,
        maxWidth: 960,
        margin: "0 auto",
        color: V("fg", "#1a1a1a"),
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>{dash.title}</h1>
      {dash.description && (
        <p style={{ color: V("muted", "#666"), margin: "0 0 20px", lineHeight: 1.5 }}>{dash.description}</p>
      )}
      <Controls />
      <Panel givens={givens} />
    </div>
  );
}
