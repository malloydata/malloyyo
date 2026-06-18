// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Layer 1 — the wire contract. Every surface imports these; they are the
// "one definition everywhere" that makes surfaces congruent.
//
// Conventions: wire keys are snake_case. `description` is always emitted
// (null when absent — it is signal); other optional fields are omitted when
// empty or unavailable. Fields marked "develop only" are stripped by the
// explore projection (see project.ts).

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
  mustQuote?: boolean;
  /** Malloy atomic type: string | number | date | timestamp | boolean | … */
  type: string;
  /** Only when the defining expression differs from the field name. */
  expression?: string;
  description: string | null;
  annotations?: Annotation[];
  location?: Loc; // develop only
}

export interface ViewInfo {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted in Malloy. */
  mustQuote?: boolean;
  description: string | null;
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
  mustQuote?: boolean;
  relationship: 'one' | 'many' | 'cross';
  /** Set when the target is a named source — look it up in `sources`. */
  source_ref?: string;
  /**
   * Inline field groups: present when the target is anonymous (nested or
   * repeated record — no name to reference), or when expand:'inline' was
   * requested. Invariant: every join has source_ref and/or fields.
   */
  fields?: FieldGroups;
  description: string | null;
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
  mustQuote?: boolean;
  description: string | null;
  primary_key: string | null;
  annotations?: Annotation[];
  location?: Loc; // develop only (absent also means: defined in an import)
  /** The source's verbatim declaration text (`name is … extend { … }`), sliced
      from its `location`. Develop only in the JSON; on the explore surface the
      source text is delivered as a separate clean Malloy content block (not
      escaped in JSON). Absent when the source could not be re-read. */
  body?: string;
}

// ── model level (canonical walker output) ──────────────────────────

export interface GivenInfo {
  /** Caller-facing surface name, no `$` prefix. */
  name: string;
  /** Rendered type: "string", "date", "filter<timestamp>", "record[]", … */
  type: string;
  /** True when the declaration provides a default — caller may omit a value. */
  has_default: boolean;
  description: string | null;
  annotations?: Annotation[];
  location?: Loc; // develop only
  body?: string; // sliced declaration source (develop + explore when readSource present)
}

export interface NamedQueryInfo {
  name: string;
  /** Present (true) only when `name` must be backtick-quoted in Malloy. */
  mustQuote?: boolean;
  description: string | null;
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

// ── catalog entries (advisory list) ────────────────────────────────

export interface ModelEntry {
  /** Host-defined: a dataset name for a registry host, a relative path for a
      directory host, … Resolution must be O(one lookup). */
  model_ref: string;
  description: string | null;
  /** Advisory hints when the host knows them cheaply (e.g. stored at publish
      time). Never required, never guaranteed complete. */
  sources?: string[];
  queries?: string[];
}

export interface ModelList {
  entries: ModelEntry[];
  /** Pages THIS view; its exhaustion means "end of this view", not "end of
      the catalog". Lists are advisory and carry no completeness guarantee. */
  next_cursor?: string;
}

// ── tool-layer envelopes ───────────────────────────────────────────

export interface SourceDescribeResult {
  ok: boolean;
  /** The model the source was resolved in. */
  model_ref: string;
  /** The source requested. */
  source: string;
  /**
   * The requested source plus the sources its joins transitively reach
   * (the join closure). A source is the unit of describe — model-scope
   * named queries are a source's `views`; model givens come from the
   * `query`/`execute:false` loop, not from describe.
   */
  sources?: Record<string, SourceInfo>;
  /**
   * The requested source + closure as VERBATIM Malloy — delivered as its own
   * clean content block (toContent lifts it out so code is never escaped in the
   * JSON block). The structured `sources` above carry no raw `body` text.
   */
  malloy_text?: string;
  problems: Problem[];
}

export interface HelpTopic {
  slug: string;
  title: string;
  body: string;
}

export type Surface = 'develop' | 'explore';
