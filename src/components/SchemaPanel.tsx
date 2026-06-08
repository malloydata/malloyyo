// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type FieldNode = {
  name: string;
  kind: "dimension" | "measure" | "view" | "join";
  type?: string;
  description: string | null;
  relationship?: string;
  fields?: FieldNode[];
};

type SchemaData = {
  source: string;
  fields: { primary_key: string | null; fields: FieldNode[] } | null;
};

// Module-level cache: persists across renders, cleared per source on demand.
const schemaCache = new Map<string, SchemaData>();

function kindColor(kind: FieldNode["kind"]) {
  switch (kind) {
    case "measure":   return "text-blue-600 dark:text-blue-400";
    case "dimension": return "text-gray-500 dark:text-gray-400";
    case "view":      return "text-purple-600 dark:text-purple-400";
    case "join":      return "text-amber-600 dark:text-amber-400";
  }
}

function kindLabel(kind: FieldNode["kind"]) {
  switch (kind) {
    case "measure":   return "M";
    case "dimension": return "D";
    case "view":      return "V";
    case "join":      return "J";
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function FieldRow({ name, field, prefix }: { name: string; field: FieldNode; prefix?: string }) {
  const fullPath = prefix ? `${prefix}.${name}` : name;
  return (
    <button
      onClick={() => copy(fullPath)}
      className="flex items-baseline gap-1.5 py-0.5 w-full text-left hover:bg-gray-100 dark:hover:bg-gray-800/60 rounded px-1 -mx-1 group"
      title={`Copy: ${fullPath}`}
    >
      <span className={`text-[10px] font-bold w-3 flex-shrink-0 ${kindColor(field.kind)}`}>
        {kindLabel(field.kind)}
      </span>
      <span className="text-[11px] text-gray-700 dark:text-gray-300 font-mono truncate flex-1">
        {name}
      </span>
      {field.type && (
        <span className="text-[10px] text-gray-400 dark:text-gray-600 flex-shrink-0 opacity-0 group-hover:opacity-100">{field.type}</span>
      )}
    </button>
  );
}

function FieldSection({ title, fields, prefix }: { title: string; fields: FieldNode[]; prefix?: string }) {
  if (fields.length === 0) return null;
  return (
    <div className="mb-2">
      <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-600 uppercase tracking-wider mb-0.5">{title}</p>
      {fields.map((f) => (
        <FieldRow key={f.name} name={f.name} field={f} prefix={prefix} />
      ))}
    </div>
  );
}

function JoinSection({ join, prefix }: { join: FieldNode; prefix?: string }) {
  const [open, setOpen] = useState(true);
  const subFields = join.fields ?? [];
  const dimensions = subFields.filter((f) => f.kind === "dimension");
  const measures   = subFields.filter((f) => f.kind === "measure");
  const views      = subFields.filter((f) => f.kind === "view");
  const nestedJoins = subFields.filter((f) => f.kind === "join");
  const fullPath = prefix ? `${prefix}.${join.name}` : join.name;

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 w-full text-left mb-0.5 group"
      >
        <span className="text-[10px] text-amber-600 dark:text-amber-400 font-bold">{open ? "▾" : "▸"}</span>
        <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 tracking-wide font-mono">{fullPath}</span>
        {join.relationship && (
          <span className="text-[10px] text-gray-400 dark:text-gray-600 ml-1">({join.relationship})</span>
        )}
      </button>
      {open && (
        <div className="pl-3 border-l border-amber-200 dark:border-amber-900/50">
          <FieldSection title="Views"      fields={views}      prefix={fullPath} />
          <FieldSection title="Dimensions" fields={dimensions} prefix={fullPath} />
          <FieldSection title="Measures"   fields={measures}   prefix={fullPath} />
          {nestedJoins.map((j) => <JoinSection key={j.name} join={j} prefix={fullPath} />)}
        </div>
      )}
    </div>
  );
}

export type SourceOption = { source: string; description: string | null };

// A compact dropdown for switching which source's schema is shown. Each row is
// more than a name — the source's description sits dimmed beneath it.
function SourcePicker({
  value,
  sources,
  onChange,
}: {
  value: string | null;
  sources: SourceOption[];
  onChange: (source: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The menu is rendered in a portal on document.body so it escapes the schema
  // panel's overflow-hidden clip (otherwise it's buried under the middle panel).
  // We right-align it to the button using its on-screen rect.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setOpen(true);
  };

  return (
    <div className="min-w-0">
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1 min-w-0 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
        title="Switch source"
      >
        <span className="truncate">{value ?? "Schema"}</span>
        <span className="text-[9px] text-gray-400 dark:text-gray-600 flex-shrink-0">▾</span>
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-64 max-h-80 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1"
            style={{ top: pos.top, right: pos.right }}
          >
            {sources.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-gray-400 dark:text-gray-600">No sources.</p>
            ) : (
              sources.map((s) => (
                <button
                  key={s.source}
                  onClick={() => { onChange(s.source); setOpen(false); }}
                  className={`block w-full text-left px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800/60 ${
                    s.source === value ? "bg-gray-50 dark:bg-gray-900" : ""
                  }`}
                >
                  <span className="block font-mono text-[11px] text-gray-800 dark:text-gray-200 truncate">{s.source}</span>
                  {s.description && (
                    <span className="block text-[10px] text-gray-400 dark:text-gray-500 leading-snug line-clamp-2">{s.description}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

interface Props {
  source: string | null;
  onClose: () => void;
  sources?: SourceOption[];
  onSourceChange?: (source: string) => void;
}

export function SchemaPanel({ source, onClose, sources, onSourceChange }: Props) {
  const [schema, setSchema] = useState<SchemaData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchSchema = useCallback((src: string, bust = false) => {
    if (bust) schemaCache.delete(src);
    if (!bust && schemaCache.has(src)) {
      setSchema(schemaCache.get(src)!);
      setLoading(false);
      return;
    }
    setLoading(true);
    setSchema(null);
    fetch(`/api/schema?source=${encodeURIComponent(src)}`)
      .then((r) => r.json())
      .then((data: SchemaData) => {
        schemaCache.set(src, data);
        setSchema(data);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!source) { setSchema(null); return; }
    fetchSchema(source);
  }, [source, fetchSchema]);

  const currentDescription = sources?.find((s) => s.source === source)?.description ?? null;

  const fields = schema?.fields?.fields ?? [];
  const views      = fields.filter((f) => f.kind === "view");
  const dimensions = fields.filter((f) => f.kind === "dimension");
  const measures   = fields.filter((f) => f.kind === "measure");
  const joins      = fields.filter((f) => f.kind === "join");

  return (
    <aside className="w-56 flex-shrink-0 border-l border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
        {sources && onSourceChange ? (
          <SourcePicker value={source} sources={sources} onChange={onSourceChange} />
        ) : (
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate">
            {source ?? "Schema"}
          </span>
        )}
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          {source && (
            <button
              onClick={() => fetchSchema(source, true)}
              disabled={loading}
              className="text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 text-xs disabled:opacity-40"
              title="Refresh schema"
            >
              ↻
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 text-xs"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="overflow-y-auto flex-1 px-3 py-2 font-mono text-xs">
        {currentDescription && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug mb-2 font-sans">{currentDescription}</p>
        )}
        {loading && <p className="text-gray-400 dark:text-gray-600 text-[11px]">loading…</p>}
        {!loading && !schema && source && <p className="text-gray-400 dark:text-gray-600 text-[11px]">not found</p>}
        {schema && (
          <>
            <FieldSection title="Views"      fields={views} />
            <FieldSection title="Dimensions" fields={dimensions} />
            <FieldSection title="Measures"   fields={measures} />
            {joins.map((j) => <JoinSection key={j.name} join={j} />)}
          </>
        )}
      </div>
    </aside>
  );
}
