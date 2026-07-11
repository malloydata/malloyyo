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
import { dashboardInfo, givenSpecs, filters, useGiven, useOptions, useDashboard, Panel } from "./runtime";

const V = (name, fallback) => `var(--dash-${name}, ${fallback})`;
const label_ = (spec) => spec?.tags?.label ?? spec?.name;

const labelStyle = { color: V("muted", "#888"), marginBottom: 4, fontSize: 13 };
const hintStyle = { fontSize: 11, color: V("muted", "#888"), marginTop: 3, minHeight: 14 };
const controlStyle = {
  fontSize: 14,
  padding: "5px 8px",
  borderRadius: 6,
  border: `1px solid ${V("border", "#ccc")}`,
  background: V("control-bg", "white"),
  color: V("fg", "#1a1a1a"),
};

const clearBtnStyle = {
  position: "absolute",
  right: 4,
  top: "50%",
  transform: "translateY(-50%)",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: V("muted", "#888"),
  fontSize: 16,
  lineHeight: 1,
  padding: "0 4px",
};

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: V("chip-bg", "#eef2ff"),
  color: V("chip-fg", "#3730a3"),
  borderRadius: 6,
  padding: "2px 4px 2px 8px",
  fontSize: 13,
  lineHeight: 1.4,
};
const chipXStyle = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 15,
  lineHeight: 1,
  padding: 0,
  opacity: 0.7,
};
const dropdownStyle = {
  position: "absolute",
  zIndex: 20,
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  margin: 0,
  padding: 4,
  listStyle: "none",
  maxHeight: 220,
  overflowY: "auto",
  background: V("control-bg", "#fff"),
  border: `1px solid ${V("border", "#ccc")}`,
  borderRadius: 8,
  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
};
const dropdownItemStyle = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: V("fg", "#1a1a1a"),
  fontSize: 14,
  padding: "6px 8px",
  borderRadius: 6,
  cursor: "pointer",
};

const btnBase = { fontSize: 14, padding: "7px 14px", borderRadius: 6 };
const primaryBtnStyle = (enabled) => ({
  ...btnBase,
  background: V("accent", "#2563eb"),
  color: V("accent-fg", "#fff"),
  border: "1px solid transparent",
  opacity: enabled ? 1 : 0.5,
  cursor: enabled ? "pointer" : "default",
});
const secondaryBtnStyle = (enabled) => ({
  ...btnBase,
  background: V("control-bg", "#fff"),
  color: V("fg", "#1a1a1a"),
  border: `1px solid ${V("border", "#ccc")}`,
  opacity: enabled ? 1 : 0.5,
  cursor: enabled ? "pointer" : "default",
});

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
    Users can type filter expressions: `Emma, Olivia`, `Em%`, `-NY`.

    Free text can't re-run per keystroke (a half-typed expression is invalid), so
    it commits on Enter/blur. That action is made explicit: a "Press ↵ to apply"
    hint shows while the draft differs from what's running, and an inline ✕ clears
    the box (committing the empty = no-filter value). Esc also clears. */
export function Search({ given, label, placeholder, style }) {
  const { value, set, spec } = useGiven(given);
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  // Suggest against the last typed token so `Emma, Ol` suggests Olivia.
  const lastTerm = draft.split(",").pop().trim();
  const { options } = useOptions(given, lastTerm);
  const filterType = spec?.filterType ?? "string";
  const empty = draft.trim() === "";
  const valid = empty || filters.isValid(filterType, draft);
  const current = value ?? "";
  const dirty = draft !== current;
  const listId = `dash-options-${given}`;
  const commit = () => {
    const next = draft.trim();
    if (!valid || next === current) return;
    set(next); // "" is a valid commit: clears the filter (matches all)
  };
  const clear = () => {
    setDraft("");
    if (current !== "") set("");
  };
  return (
    <Field label={label ?? label_(spec)}>
      <div style={{ position: "relative", display: "inline-block" }}>
        <input
          value={draft}
          list={listId}
          placeholder={placeholder ?? spec?.description}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") clear();
          }}
          style={{
            ...controlStyle,
            minWidth: 180,
            paddingRight: 26,
            border: `1px solid ${valid ? V("border", "#ccc") : V("danger", "#d33")}`,
            ...style,
          }}
        />
        {!empty && (
          <button type="button" onClick={clear} aria-label="Clear" style={clearBtnStyle}>
            ×
          </button>
        )}
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </div>
      <div style={{ ...hintStyle, color: valid ? V("muted", "#888") : V("danger", "#d33") }}>
        {!valid ? "Invalid filter expression" : dirty ? "Press ↵ to apply" : " "}
      </div>
    </Field>
  );
}

/** A tokenized multi-select bound to a filter<string> given: each pick becomes a
    removable chip and the committed value is an exact-match alternatives filter
    (`Emma, Olivia, Sophia`), round-tripped through filters.oneOf / filters.values.
    Suggestions come from the given's `# suggest {…}` tag (server-side typeahead
    when it names a dimension) or an explicit `options` prop. Backspace on an
    empty box removes the last chip; empty selection = no filter (all). */
export function MultiSelect({ given, label, placeholder, options, style }) {
  const { value, set, spec } = useGiven(given);
  const selected = filters.values(value ?? "") ?? [];
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const suggested = useOptions(given, term);
  const commit = (vals) => set(vals.length ? filters.oneOf(...vals) : "");
  const add = (v) => {
    const t = String(v).trim();
    setTerm("");
    if (!t || selected.includes(t)) return;
    commit([...selected, t]);
  };
  const remove = (v) => commit(selected.filter((x) => x !== v));
  const source = options
    ? options.map((o) => (typeof o === "object" ? String(o.value) : String(o)))
    : suggested.options.map(String);
  const lower = term.toLowerCase();
  const avail = source
    .filter((o) => !selected.includes(o))
    .filter((o) => o.toLowerCase().includes(lower))
    .slice(0, 50);
  return (
    <Field label={label ?? label_(spec)}>
      <div style={{ position: "relative", minWidth: 220, ...style }}>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", ...controlStyle, padding: 5 }}
          onClick={() => setOpen(true)}
        >
          {selected.map((v) => (
            <span key={v} style={chipStyle}>
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                // mouseDown+preventDefault so removing a chip doesn't blur the input
                onMouseDown={(e) => {
                  e.preventDefault();
                  remove(v);
                }}
                style={chipXStyle}
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={term}
            placeholder={selected.length ? "" : placeholder ?? "Add…"}
            onChange={(e) => {
              setTerm(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(avail[0] ?? term);
              } else if (e.key === "Backspace" && !term && selected.length) {
                remove(selected[selected.length - 1]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            style={{
              border: "none",
              outline: "none",
              background: "transparent",
              color: V("fg", "#1a1a1a"),
              fontSize: 14,
              flex: 1,
              minWidth: 80,
              padding: "2px 0",
            }}
          />
        </div>
        {open && avail.length > 0 && (
          <ul style={dropdownStyle}>
            {avail.map((o) => (
              <li key={o}>
                <button
                  type="button"
                  // preventDefault keeps focus in the input so the dropdown stays
                  // open for picking several in a row.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(o);
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = V("controls-bg", "#f3f4f6"))}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  style={dropdownItemStyle}
                >
                  {o}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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

/** Relative-time presets + a custom literal range, bound to a
    filter<timestamp|date> given. Presets are {value, text} where value is a
    temporal filter EXPRESSION ('' = all time, '7 days' = the last 7 days) —
    override via the `presets` prop or the declaration's tags. Picking
    "Custom range…" swaps in from/to date inputs committed through
    filters.dateRange (never hand-built strings). */
export function TimeRange({ given, label, presets, style }) {
  const { value, set, spec } = useGiven(given);
  const range = filters.temporalRange(value ?? "");
  const [custom, setCustom] = useState(!!range);
  const [draft, setDraft] = useState({ from: range?.from ?? "", to: range?.to ?? "" });
  // Follow external value changes (URL-seeded links, artifact-tag defaults).
  useEffect(() => {
    const r = filters.temporalRange(value ?? "");
    setCustom(!!r);
    if (r) setDraft({ from: r.from, to: r.to });
  }, [value]);
  const opts = (presets ?? DEFAULT_TIME_PRESETS).map((o) =>
    typeof o === "object" ? o : { value: String(o), text: String(o) },
  );
  const CUSTOM = "__custom__";
  const current = custom ? CUSTOM : (value ?? "");
  if (!custom && !opts.some((o) => o.value === current)) {
    opts.push({ value: current, text: current || "All time" });
  }
  const commitCustom = (next) => {
    setDraft(next);
    if (next.from && next.to) set(filters.dateRange(next.from, next.to));
  };
  const dateInput = (key) => (
    <input
      type="date"
      value={draft[key]}
      onChange={(e) => commitCustom({ ...draft, [key]: e.target.value })}
      style={controlStyle}
    />
  );
  return (
    <Field label={label ?? label_(spec)} style={style}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={current}
          onChange={(e) => {
            if (e.target.value === CUSTOM) setCustom(true);
            else {
              setCustom(false);
              set(e.target.value);
            }
          }}
          style={controlStyle}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
          <option value={CUSTOM}>Custom range…</option>
        </select>
        {custom && (
          <>
            {dateInput("from")}
            <span style={{ color: V("muted", "#888") }}>to</span>
            {dateInput("to")}
          </>
        )}
      </div>
    </Field>
  );
}

export const DEFAULT_TIME_PRESETS = [
  { value: "", text: "All time" },
  { value: "today", text: "Today" },
  { value: "7 days", text: "Last 7 days" },
  { value: "30 days", text: "Last 30 days" },
  { value: "90 days", text: "Last 90 days" },
  { value: "12 months", text: "Last 12 months" },
];

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
    tags → Range, temporal filter → TimeRange, control=multiselect → MultiSelect,
    suggestions + control=select → Select, boolean → Checkbox, else → Search. */
export function Given({ name, ...rest }) {
  const spec = givenSpecs().find((s) => s.name === name);
  if (!spec) return null;
  const tags = spec.tags ?? {};
  if (spec.filterType === "number" && tags.range_min != null && tags.range_max != null) {
    return <Range given={name} {...rest} />;
  }
  if (spec.filterType === "timestamp" || spec.filterType === "timestamptz" || spec.filterType === "date") {
    return <TimeRange given={name} {...rest} />;
  }
  if (tags.control === "multiselect") return <MultiSelect given={name} {...rest} />;
  if (spec.suggest && tags.control === "select") return <Select given={name} {...rest} />;
  if (spec.type === "boolean") return <Checkbox given={name} {...rest} />;
  return <Search given={name} {...rest} />;
}

/** Every given the dashboard's query references, laid out in a filter bar. Under
    `# artifact { autorun=false }` the bar grows an Apply/Reset pair — controls
    edit a draft and nothing re-runs until Apply. In the live default (autorun),
    changes re-run immediately and no buttons show. */
export function Controls({ style, children }) {
  const { autorun, apply, reset, dirty } = useDashboard();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 20,
        padding: "14px 16px",
        background: V("controls-bg", "#f6f7f9"),
        border: `1px solid ${V("border", "#e5e7eb")}`,
        borderRadius: V("radius", "8px"),
        ...style,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 24, flex: 1 }}>
        {children ?? givenSpecs().map((s) => <Given key={s.name} name={s.name} />)}
      </div>
      {!autorun && (
        <div style={{ display: "flex", gap: 8, alignSelf: "center" }}>
          <button type="button" onClick={reset} disabled={!dirty} style={secondaryBtnStyle(dirty)}>
            Reset
          </button>
          <button type="button" onClick={apply} disabled={!dirty} style={primaryBtnStyle(dirty)}>
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

/** The whole no-code dashboard: title + doc comment + controls + panel. Used
    when a `# artifact`-tagged query ships no Dashboard.tsx.

    App-like layout: the frame page itself never scrolls (both hosts embed it
    in a fixed-height iframe) — title and controls stay pinned and the Panel
    is the ONE scroll container, so the renderer's virtualizer (bound to the
    panel via scrollEl) sees real scroll events instead of fighting the page. */
export function DefaultDashboard({ givens, theme }) {
  const dash = dashboardInfo();
  // theme={{ accent:"#e11d48", controlsBg:"#fff", … }} → --dash-accent etc. on
  // this wrapper, overriding the runtime defaults for this dashboard only.
  const vars = {};
  if (theme) for (const [k, v] of Object.entries(theme)) vars[`--dash-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`] = v;
  return (
    <div
      style={{
        fontFamily: V("font", "system-ui, sans-serif"),
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        padding: 24,
        maxWidth: 960,
        margin: "0 auto",
        color: V("fg", "#1a1a1a"),
        ...vars,
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 4px", flexShrink: 0 }}>{dash.title}</h1>
      {dash.description && (
        <p style={{ color: V("muted", "#666"), margin: "0 0 20px", lineHeight: 1.5, flexShrink: 0 }}>{dash.description}</p>
      )}
      <Controls style={{ flexShrink: 0 }} />
      <Panel givens={givens} style={{ flex: 1, minHeight: 0, maxHeight: "none" }} />
    </div>
  );
}
