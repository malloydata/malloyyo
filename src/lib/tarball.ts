// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * A repo, as one archive.
 *
 * The repo is the unit of publish, so it is also the unit of TRANSFER. Both ways
 * a repo reaches this server end up here: GitHub hands us
 * `/repos/{o}/{r}/tarball/{ref}`, and `malloyyo publish` builds the same shape
 * from a working directory. One extractor, one file map, one ingestion path —
 * rather than a GitHub-shaped reader and a CLI-shaped one that agree until they
 * do not.
 *
 * WHY NOT FILE BY FILE. Reading a repo through the contents API costs one
 * request per file, and an instance with no `GITHUB_TOKEN` has sixty an hour for
 * everything. A four-dataset repo — each with an entry, its imports, a
 * dashboards listing and a component per dashboard — spent all sixty on a single
 * refresh. Measured, twice. One request for the archive is not an optimisation
 * so much as the difference between a repo that can refresh and one that cannot.
 *
 * Deliberately NOT a dependency. tar is 512-byte blocks and an octal size; the
 * whole reader is below, and it is tested against a real GitHub tarball rather
 * than a fixture we wrote to match our own assumptions.
 */

import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/**
 * Files worth keeping. A model repo may also hold committed data, built docs,
 * or images, and decoding those to strings would cost memory for bytes nothing
 * reads. Everything the model path ever asks for is text with one of these
 * extensions.
 */
const KEEP = new Set([".malloy", ".json", ".jsx", ".tsx", ".ts", ".js", ".md", ".sql", ".csv", ".txt"]);

/** Per file, and for the archive as a whole. A repo that exceeds these is not
    one this server can usefully compile, and the caps are what stop a
    pathological repo from being an out-of-memory. */
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

function str(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? s.length : end).toString("utf8").trim();
}

/** Octal, space- or NUL-padded. Empty means zero. */
function octal(b: Buffer, start: number, len: number): number {
  const s = str(b, start, len).replace(/[^0-7]/g, "");
  return s ? parseInt(s, 8) : 0;
}

export type Tarball = {
  /** Repo-relative path → contents. Any single leading directory the archive
      wraps everything in has been stripped. */
  files: Map<string, string>;
  /** Paths seen but not kept (binary, oversized) — so a caller can say why a
      file it expected is missing instead of reporting it as absent. */
  skipped: string[];
};

/**
 * Extract a gzipped tar into a repo-relative file map.
 *
 * Handles what GitHub's archives actually contain: ustar headers, the `prefix`
 * field for paths over 100 characters, GNU long names (`L`) and pax extended
 * headers (`x`) for longer ones still. An unrecognised entry type is skipped
 * rather than guessed at.
 */
export function extractTarGz(gz: Buffer): Tarball {
  let buf: Buffer;
  try {
    buf = gunzipSync(gz);
  } catch (e) {
    throw new Error(`not a gzipped archive: ${e instanceof Error ? e.message : String(e)}`);
  }

  const raw = new Map<string, string>();
  const skipped: string[] = [];
  let total = 0;
  let offset = 0;
  // Set by an 'L' or 'x' entry, and consumed by the entry after it.
  let pendingName: string | null = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((b) => b === 0)) break;

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) break; // truncated archive
    // Entries are padded out to a whole number of blocks.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      // GNU long name: this entry's DATA is the next entry's path.
      pendingName = buf.subarray(dataStart, dataEnd).toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "x" || type === "g") {
      // pax extended header: "<len> key=value\n" records. Only `path` matters.
      const rec = buf.subarray(dataStart, dataEnd).toString("utf8");
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(rec);
      if (type === "x" && m) pendingName = m[1];
      continue;
    }

    let name = pendingName ?? str(header, 0, 100);
    pendingName = null;
    if (!name) continue;
    const prefix = str(header, 345, 155);
    if (prefix && !name.startsWith(prefix)) name = `${prefix}/${name}`;

    // Regular file only. A NUL typeflag already read as "0" above; '5' is a
    // directory, and the rest (links, devices) have no meaning for a model repo.
    if (type !== "0") continue;
    if (size === 0) continue;

    const dot = name.lastIndexOf(".");
    const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
    if (!KEEP.has(ext) || size > MAX_FILE) {
      skipped.push(name);
      continue;
    }
    total += size;
    if (total > MAX_TOTAL) {
      throw new Error(`archive exceeds ${Math.round(MAX_TOTAL / 1024 / 1024)}MB of model files`);
    }
    raw.set(name, buf.subarray(dataStart, dataEnd).toString("utf8"));
  }

  // One wrapper directory, stripped from both lists together — the same root or
  // neither, since `skipped` exists to explain a gap in `files`.
  //
  // Only when it IS a wrapper. `datasets/a/index.malloy` + `datasets/b/…` share a
  // first component and are not wrapped in anything; stripping there would turn a
  // multi-dataset repo into two nameless ones. So: if the paths already look like
  // a repo root, leave them; otherwise strip, and only if that makes them look
  // like one.
  const all = [...raw.keys(), ...skipped];
  const candidate = looksLikeRepoRoot(all) ? null : commonRoot(all);
  const stripped = candidate
    ? all.map((p) => (p.startsWith(`${candidate}/`) ? p.slice(candidate.length + 1) : p))
    : [];
  const root = candidate && looksLikeRepoRoot(stripped) ? candidate : null;
  const strip = (p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const files = new Map<string, string>();
  for (const [p, c] of raw) files.set(strip(p), c);
  return { files, skipped: skipped.map(strip) };
}

/**
 * Does this set of paths look like the root of a model repo?
 *
 * The test that keeps wrapper-stripping honest. A repo whose ONLY top-level
 * entry is `datasets/` is a perfectly ordinary multi-dataset repo, and it shares
 * a single first path component exactly like a GitHub wrapper does — so
 * "everything is under one directory" cannot be the rule. Strip only when the
 * result looks MORE like a repo than the original did.
 */
function looksLikeRepoRoot(paths: Iterable<string>): boolean {
  for (const p of paths) {
    if (p === "index.malloy" || p === "malloy-config.json") return true;
    if (p.startsWith("datasets/")) return true;
  }
  return false;
}

/** The single directory every entry sits under, if there is one.
    GitHub wraps a tarball in `{owner}-{repo}-{sha}/`; an archive built from a
    working directory may have no wrapper at all. */
function commonRoot(paths: Iterable<string>): string | null {
  let root: string | null = null;
  for (const p of paths) {
    const slash = p.indexOf("/");
    if (slash <= 0) return null; // a file at the top level: no wrapper
    const head = p.slice(0, slash);
    if (root === null) root = head;
    else if (root !== head) return null;
  }
  return root;
}

/**
 * A URLReader over an extracted archive.
 *
 * Shaped like `GitHubURLReader` — including `fetched`, which records what the
 * compiler actually asked for. That distinction is load-bearing: the archive
 * holds the whole repo, but a dataset stores its own transitive closure, so
 * `fetched` is what gets written and the rest is never anybody's file.
 */
export class ArchiveURLReader {
  readonly fetched = new Map<string, string>();

  constructor(private readonly files: ReadonlyMap<string, string>) {}

  async readURL(url: URL): Promise<string> {
    const path = url.pathname.replace(/^\//, "");
    const content = this.files.get(path);
    if (content === undefined) {
      // The same shape of message the per-file reader gives, because an author
      // reading it cannot tell which path the server took.
      throw new Error(`Not found: ${path} in the repo archive.`);
    }
    this.fetched.set(path, content);
    return content;
  }
}

/** Direct children of `dir` in an extracted archive ("" being the root). */
export function archiveDir(files: ReadonlyMap<string, string>, dir: string): string[] {
  const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
  const out: string[] = [];
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    out.push(rest);
  }
  return out.sort();
}

/**
 * Direct children of `dir`, files and directories both, shaped like a directory
 * listing.
 *
 * An archive holds no directory entries of its own — a directory exists because
 * something is under it — so they are inferred from the paths. Lets the layout
 * rules run against an archive without a second trip to GitHub for a tree.
 */
export function archiveEntries(
  files: ReadonlyMap<string, string>,
  dir: string,
): { name: string; path: string; type: "file" | "dir" }[] {
  const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
  const seen = new Map<string, "file" | "dir">();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) seen.set(rest, "file");
    else seen.set(rest.slice(0, slash), "dir");
  }
  return [...seen.entries()]
    .map(([name, type]) => ({ name, path: prefix + name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
