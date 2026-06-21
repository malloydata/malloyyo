// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Layer 1 — the wire contract. Every surface imports these; they are the
// "one definition everywhere" that makes surfaces congruent.
//
// Conventions: wire keys are snake_case. Optional fields (`description`,
// `instructions`, `must_quote`, …) are OMITTED when empty or unavailable —
// never emitted as null (a null would bloat field lists for no signal). Fields
// marked "develop only" are stripped by the explore projection (see project.ts).

/** [line, column], 0-based, start position only. Develop surface only. */
export type Loc = [number, number];

export interface Annotation {
  route: string; // e.g. '"' (description), '# ' (render tags)
  text: string;
}

/** Uniform problem shape used by every helper and tool response. */
export interface Problem {
  severity: 'error' | 'warn' | 'debug';
  message: string;
  /** Malloy's stable error code (or an engine code like 'source-not-found'). */
  code: string;
  uri?: string;
  line?: number; // 0-based
  column?: number;
  end_line?: number;
  end_column?: number;
  /** Set when `code` maps to a yo_help topic — fetch it to fix it. */
  help_topic?: string;
}

// ── the describe-shape ─────────────────────────────────────────────

export interface FieldInfo {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted to write in
      Malloy (reserved word, or non-identifier characters). */
  must_quote?: boolean;
  /** Malloy atomic type: string | number | date | timestamp | boolean | … */
  type: string;
  /** Only when the defining expression differs from the field name. */
  expression?: string;
  description?: string;
  instructions?: string;
  annotations?: Annotation[];
  location?: Loc; // develop only
}

export interface ViewInfo {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted in Malloy. */
  must_quote?: boolean;
  description?: string;
  instructions?: string;
  annotations?: Annotation[];
  location?: Loc; // develop only
  /** The view's defining source text (`name is { … }`), sliced from its
      `location`. Present (on develop and explore) only when readSource was
      available; absent when the source could not be re-read. */
  body?: string;
}

export interface JoinInfo {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted in Malloy. */
  must_quote?: boolean;
  relationship: 'one_to_many' | 'many_to_one' | 'cross';
  /** Set when the target is a named source reachable in this model's namespace
      — look it up in `sources`. */
  source_ref?: string;
  /**
   * Set when the target is an unmodified reference to a source that is NOT
   * nameable in this model's namespace (e.g. reached only through a transitive
   * import) — an index into the OWNING source's `anon_srcs` array. Navigate-only:
   * an anon source is a describe target, never a query target (it has no name to
   * write in Malloy). Joins to the same un-nameable source share one index.
   */
  anon_src_index?: number;
  /**
   * Inline field groups: present when the target defines its own shape (a
   * nested/repeated record, a SQL block, a query source, or a modified/extended
   * source — nothing to reference), or when expand:'inline' was requested.
   * Invariant: every join has source_ref, anon_src_index, and/or fields.
   */
  fields?: FieldGroups;
  /** Set on a SYNTHETIC data-shape join — a column that Malloy models as an
      explore field but is really part of the row, not a relationship to another
      source. The explore surface renders 'record' as a nested-type dimension and
      the two array shapes as `joins` entries + dimension stubs. Absent on real
      source-joins (named refs, sql/query blocks, transitive-import targets). */
  column_shape?: 'record' | 'scalar_array' | 'record_array';
  description?: string;
  instructions?: string;
  annotations?: Annotation[];
  location?: Loc; // develop only
  /** The join's defining source text (`name is target on …`/`with …`), sliced
      from its `location` — carries the join keys. Real joins only (synthetic
      nested-record/array joins have no own declaration). Absent when the source
      could not be re-read. */
  body?: string;
}

export interface FieldGroups {
  dimensions: FieldInfo[];
  measures: FieldInfo[];
  views: ViewInfo[];
  joins: JoinInfo[];
}

export interface SourceInfo extends FieldGroups {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted in Malloy. */
  must_quote?: boolean;
  description?: string;
  instructions?: string;
  primary_key: string | null;
  annotations?: Annotation[];
  location?: Loc; // develop only (absent also means: defined in an import)
  /** The source's verbatim declaration text (`name is … extend { … }`), sliced
      from its `location`. Develop only in the JSON; on the explore surface the
      source text is delivered as a separate clean Malloy content block (not
      escaped in JSON). Absent when the source could not be re-read. */
  body?: string;
  /**
   * Un-nameable join targets owned by this source: sources reached through a
   * join whose target cannot be named in this model's namespace (a transitive
   * import). A JoinInfo.anon_src_index indexes into this array. Deduped — joins
   * to the same un-nameable source share one entry. Omitted when empty. These
   * are describe-only; they carry no addressable name.
   */
  anon_srcs?: SourceInfo[];
}

// ── explore projection wire shape ──────────────────────────────────
// On the explore surface a source's child collections (dimensions, measures,
// views, joins) ship as objects keyed by member name — the `name` field is
// lifted to the key, which both shrinks the payload and lets a client look a
// member up by name. The maps are built on a null-prototype object (see
// project.ts `byName`) so a member named `constructor` / `__proto__` /
// `hasOwnProperty` lands as an ordinary data key, not a prototype trap — a
// name-keyed map of user-chosen identifiers is exactly where reserved names
// surface. `must_quote` stays on the value (the key is the bare identifier;
// the flag still tells a client to backtick it). `anon_srcs` stays an array:
// it is addressed positionally by JoinInfo.anon_src_index, which a name-keyed
// map would break.

/** A field (dimension/measure) value in the explore projection: a FieldInfo
    with `name` lifted to its map key and the develop-only `location` dropped. */
export type ExploreField = Omit<FieldInfo, 'name' | 'location'>;
/** A view value in the explore projection (`name` is the key; no raw `body`). */
export type ExploreView = Omit<ViewInfo, 'name' | 'location' | 'body'>;
/** A join value in the explore projection (`name` is the key). Inline `fields`,
    when present, are themselves name-keyed. */
export type ExploreJoin = Omit<JoinInfo, 'name' | 'location' | 'body' | 'fields'> & {
  fields?: ExploreFieldGroups;
};

export interface ExploreFieldGroups {
  dimensions: Record<string, ExploreField>;
  measures: Record<string, ExploreField>;
  views: Record<string, ExploreView>;
  joins: Record<string, ExploreJoin>;
}

/** A source as projected for the explore surface: identity + child collections
    keyed by member name. `name` is retained (sources are keyed by it one level
    up, but it is also the source's own identity). */
export interface ExploreSourceInfo extends ExploreFieldGroups {
  name: string;
  must_quote?: boolean;
  description?: string;
  instructions?: string;
  primary_key: string | null;
  annotations?: Annotation[];
  anon_srcs?: ExploreSourceInfo[];
}

/** Explore-surface analogue of {@link SourceDescription}. */
export interface ExploreDescription {
  requested: string;
  sources: Record<string, ExploreSourceInfo>;
}

/** Explore-surface analogue of {@link ModelInfo} (no develop-only `entry`;
    `runs` are not addressable from an explore surface). */
export interface ExploreModelInfo {
  annotations?: Annotation[];
  givens?: GivenInfo[];
  sources: Record<string, ExploreSourceInfo>;
  queries: NamedQueryInfo[];
  runs: [];
}

// ── model level (canonical walker output) ──────────────────────────

export interface GivenInfo {
  /** Caller-facing surface name, no `$` prefix. */
  name: string;
  /** Rendered type: "string", "date", "filter<timestamp>", "record[]", … */
  type: string;
  /** True when the declaration provides a default — caller may omit a value. */
  has_default: boolean;
  description?: string;
  instructions?: string;
  annotations?: Annotation[];
  location?: Loc; // develop only
  body?: string; // sliced declaration source (develop + explore when readSource present)
}

export interface NamedQueryInfo {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted in Malloy. */
  must_quote?: boolean;
  description?: string;
  instructions?: string;
  annotations?: Annotation[];
  /** Transitive given names this query references (authoritative at query scope). */
  givens?: string[];
  location?: Loc; // develop only
  body?: string; // sliced declaration source (develop + explore when readSource present)
}

export interface RunStatementInfo {
  /** 0-based index among the model's run: statements. */
  index: number;
  annotations?: Annotation[];
  givens?: string[];
  location?: Loc; // develop only
  sql?: string; // only when emitRunSql was requested
  error?: string; // SQL generation failed for this run only
}

export interface ModelInfo {
  /** Root URI the model compiled from. Develop only (leaky on the explore surface). */
  entry?: string;
  annotations?: Annotation[];
  /** Given declarations — model scope is the authoritative scope for these. */
  givens?: GivenInfo[];
  /** Keyed by name; also the lookup table for every JoinInfo.source_ref. */
  sources: Record<string, SourceInfo>;
  queries: NamedQueryInfo[];
  runs: RunStatementInfo[];
}

/**
 * describe-source selection: the requested source plus the deduped
 * transitive join closure. Deliberately NO givens here — a source's join
 * tree is only potentially activated, so sources are never an authoritative
 * given scope (model = declarations, compiled query = requirements).
 */
export interface SourceDescription {
  requested: string;
  sources: Record<string, SourceInfo>;
}

// ── result envelopes ───────────────────────────────────────────────

export interface CompileResult {
  /** false ⇒ model absent and problems contains at least one error. */
  ok: boolean;
  model?: ModelInfo;
  /**
   * Whether the entry source already matches the prettifier's canonical
   * form; false means `prettify` would change it (worth calling before
   * saving). One token instead of echoing prettified text. Omitted when it
   * can't be judged: no readSource (explore-bound describes) or the source
   * has parse errors.
   */
  formatted?: boolean;
  problems: Problem[];
}

export interface QueryValidationResult {
  ok: boolean;
  /** The generated SQL — execute:false validates AND returns it (the
      confirmatory-inspect channel; SQL never rides an executed run). */
  sql?: string;
  problems: Problem[];
  /**
   * Givens this query transitively references — FULL detail so the caller
   * can supply values (or learn a default exists) without another lookup.
   * Authoritative: computed from the compiled query, not the source.
   */
  givens?: GivenInfo[];
}

export interface TruncationInfo {
  reason: 'row_limit' | 'byte_budget';
  /** Where the host spilled the complete result, when it did. */
  full_result?: string;
  /** Actionable guidance: aggregate / top-N in Malloy / project fewer columns. */
  hint: string;
}

export interface RunResult {
  ok: boolean;
  sql?: string;
  rows?: unknown[];
  /** Rows the query produced (bounded by rowLimit). */
  row_count?: number;
  /** Rows actually present in `rows` after budgeting. */
  rows_returned?: number;
  truncated?: TruncationInfo;
  compile_time_ms?: number;
  total_time_ms?: number;
  /**
   * interfaces-format result (API.util.wrapResult) for host renderers.
   * Populated only on request (RunOptions.stableResult); never sent over MCP.
   */
  stable_result?: unknown;
  problems: Problem[];
}

export interface DescribeResult {
  ok: boolean;
  description?: SourceDescription;
  problems: Problem[];
}

// ── the host-only channel ──────────────────────────────────────────

/** The reserved key under which a surface parks data for the HOST that the
    AGENT must never see. `toContent` drops it entirely (no block, not
    serialized); a host reads it off the raw result before that. Exported so the
    one key name is shared, not re-typed at each site. */
export const HOST_ONLY = 'host_only' as const;

/** What rides on {@link HOST_ONLY}: today only the SQL of an executed run — the
    explore surface withholds SQL from the agent on execute:true (it rides
    execute:false), but the run generated it and a host records it. Typed
    end-to-end so a host reads `result.host_only.sql`, not a magic shape. */
export interface HostOnly {
  sql?: string;
}

/** A result carrying the host-only channel. The `[HOST_ONLY]` computed key keeps
    the single source of truth for the name. */
export type WithHostOnly<T> = T & { [HOST_ONLY]?: HostOnly };

// ── catalog entries (advisory list) ────────────────────────────────

/** A source as it appears in the catalog listing: enough to pick one and
    address it (its `source_ref`), with the annotations that help choose. */
export interface SourceEntry {
  source_ref: string;
  description?: string;
  instructions?: string;
  /** Present (true) only when `source_ref` must be backtick-quoted in Malloy. */
  must_quote?: boolean;
}

export interface ModelEntry {
  /** Host-defined: a dataset name for a registry host, a relative path for a
      directory host, … Resolution must be O(one lookup). */
  model_ref: string;
  description?: string;
  instructions?: string;
  /** The model's EXPORTED sources, each with its annotations. Advisory — never
      required, never guaranteed complete.
      NOTE: named queries are intentionally NOT listed yet. A named query is
      dual-natured (runnable AND usable as a source); surfacing that — and making
      describe_source treat a named query as the source it is — needs more design,
      so it is deferred out of the MVP listing. */
  sources?: SourceEntry[];
}

export interface ModelList {
  entries: ModelEntry[];
  /** Pages THIS view; its exhaustion means "end of this view", not "end of
      the catalog". Lists are advisory and carry no completeness guarantee. */
  next_cursor?: string;
}

// ── tool-layer envelopes ───────────────────────────────────────────

/** A source as it appears in {@link ListSourcesResult}: the `source_ref` is the
    map key, so only the choosing annotations remain on the value. */
export interface ListedSource {
  description?: string;
  instructions?: string;
  /** Present (true) only when the source_ref key must be backtick-quoted. */
  must_quote?: boolean;
}

/** A model as it appears in {@link ListSourcesResult}: the `model_ref` is the
    map key; its sources are keyed by `source_ref`. */
export interface ListedModel {
  description?: string;
  instructions?: string;
  sources?: Record<string, ListedSource>;
}

/** `list_sources` wire shape: models keyed by `model_ref`, each model's sources
    keyed by `source_ref` (the refs are lifted to keys — see project.ts `byName`
    for the same shape on describe). Both maps are built on null-prototype
    objects so a reserved ref (`constructor` / `__proto__` / …) is an ordinary
    data key. */
export interface ListSourcesResult {
  ok: boolean;
  /** The workflow seed (describe → validate → run → present), inlined so a
      conversation that never saw the server instructions — a second chat on a
      pooled connection — still gets it on the tool it must call to start. */
  guidance?: string;
  models: Record<string, ListedModel>;
}

// ── describe_source wire shape (explore) — see the v5 spec ─────────
// Optimized for easy+correct LLM inference: read the answer, don't derive it.
// COLUMNS (scalars, single records, arrays) live in a schema's `dimensions`;
// JOINS (relationships to other sources) live in the flat `joins` list. Arrays
// straddle: a column-stub in `dimensions` PLUS a detail entry in `joins` (they
// fan, and fan info belongs in joins). `type` is ALWAYS a real type — a member
// with no `type` is a navigable stub pointing at its `joins` entry by `path`.

/** A field's type: a scalar type name, or a record (a map of its members). */
export type CompactType = string | { [name: string]: CompactMember };

/** A value column — a scalar or a single record. Always has a real `type`. */
export interface CompactField {
  type: CompactType;
  must_quote?: boolean;
  expression?: string;
  description?: string;
  instructions?: string;
}

/** An array column, as it appears INSIDE a schema's `dimensions` (or a record
    `type`): a stub with no `type` — its detail is the `joins` entry at `path`.
    `fans_out` is always present (an array always multiplies rows when traversed)
    so the cardinality question has ONE answer everywhere. In a deduped
    `join_source_map` entry the stub is relative (no `path`), since the source is
    reached via possibly many handles; the absolute paths are in the flat `joins`
    list. */
export interface ArrayStub {
  is_array: true;
  fans_out: true;
  path?: string;
  must_quote?: boolean;
}

/** A member of a `dimensions` map (or a record `type`): a value column or an
    array-column stub. Discriminate on `type` present (value) vs `is_array`
    present (array stub). */
export type CompactMember = CompactField | ArrayStub;

/** A reached source's field surface: dimensions (columns) + measures. NO views
    (a view is invoked `source -> view`, never through a join). */
export interface CompactSchema {
  primary_key?: string | null;
  description?: string;
  instructions?: string;
  dimensions: Record<string, CompactMember>;
  measures: Record<string, CompactField>;
}

/** The described source: a CompactSchema plus its name and views. The only block
    that carries views. */
export interface ExploreDescribedSource extends CompactSchema {
  name: string;
  /** View name → one-line description, or null when the view has no `#"` doc. */
  views: Record<string, string | null>;
}

/** A `joins` entry — an ARRAY or a SOURCE-JOIN (never a scalar/record column).
    Keyed in the `joins` map by its full dotted CLEAN path (bare segments, no
    backticks — good for lookup/matching; a `dimensions` array-stub's `path`
    points at this key). To WRITE a reference: use `quoted_path` if present, else
    the key (clean paths are already paste-ready). One of three forms, by which
    keys are present:
      - array:           `{ is_array: true, fans_out: true, source_def }`
                         (record array → source_def fields; scalar array →
                          source_def has the single `each`; the key is usable bare)
      - named join:      `{ source, code, fans_out? }`
      - anonymous join:  `{ source_def, code, fans_out? }`
    `fans_out` is the TOTAL cardinality signal: present (true) on EVERYTHING that
    multiplies rows — arrays AND fanning source-joins (a join_many/cross, or a
    join_one under a fanning ancestor) — and absent otherwise. So the consumer's
    rule is one check: "fans iff `fans_out` present." `is_array` answers a
    different question (what kind of thing), not cardinality. `cycle` marks a
    re-entry onto a source already on the path. */
export interface JoinEntry {
  fans_out?: true;
  cycle?: true;
  /** The paste-ready form of this entry's path (the key), present ONLY when a
      segment needs backtick-quoting (e.g. key `team.year` → `` team.`year` ``).
      The key stays clean for lookup/matching; write the reference from this. */
  quoted_path?: string;
  is_array?: true;
  source?: string;
  source_def?: CompactSchema;
  code?: string;
}

/** The assembled structured describe_source surface (sans envelope). `joins` is
    keyed by path (built on a null-prototype object so a reserved path is safe). */
export interface ExploreSourceDescribe {
  described_source: ExploreDescribedSource;
  joins: Record<string, JoinEntry>;
  join_source_map: Record<string, CompactSchema>;
}

export interface SourceDescribeResult {
  ok: boolean;
  /** The workflow seed — same string list_sources carries, repeated here so the
      skip-straight-to-describe path (and a second chat that never saw the server
      instructions) still gets seeded. Present on a successful describe only. */
  guidance?: string;
  /** The model the source was resolved in. */
  model_ref: string;
  /** The source requested. */
  source: string;
  /** The described source — every column, plus measures and views. */
  described_source?: ExploreDescribedSource;
  /** Arrays + source-joins, keyed by path (depth-first). Omitted when empty. */
  joins?: Record<string, JoinEntry>;
  /** Every reachable NAMED source, deduped by name (CompactSchema, no views).
      Omitted when empty. */
  join_source_map?: Record<string, CompactSchema>;
  /**
   * JUST the described source's verbatim Malloy declaration — delivered as its
   * own clean content block (toContent lifts it out so code is never escaped in
   * the JSON block). Joined sources are recovered via describe_source by name.
   */
  malloy_text?: string;
  problems: Problem[];
}

export interface HelpTopic {
  /** The topic's one identifier: its namespaced path, e.g. `language/joins`.
      This is what the index lists AND what you pass back — there is no title. */
  name: string;
  body: string;
}

export type Surface = 'develop' | 'explore';
