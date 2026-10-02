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
 * whole reader and writer are below, and the reader is tested against a real
 * GitHub tarball rather than a fixture we wrote to match our own assumptions.
 *
 * IN THE ENGINE because both ends need the same format: the server extracts, the
 * CLI packs, and a round-trip test here is what keeps them one format rather than
 * two that agree today.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { DATASETS_DIR, ENTRY_FILE, type DirEntry } from "./repo-layout";

const BLOCK = 512;

/**
 * Files worth keeping. A model repo may also hold committed data, built docs,
 * or images, and decoding those to strings would cost memory for bytes nothing
 * reads. Everything the model path ever asks for is text with one of these
 * extensions.
 */
export const KEEP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".malloy", ".json", ".jsx", ".tsx", ".ts", ".js", ".md", ".sql", ".csv", ".txt",
]);

/** Is this a file a repo archive carries? Exported because the CLI packs the
    archive the server extracts — the two lists have to BE one list, and a
    comment asserting they match is not the same as them matching. */
export function keepsFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && KEEP_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Per file, and for the archive as a whole. A repo that exceeds these is not
    one this server can usefully compile, and the caps are what stop a
    pathological repo from being an out-of-memory. */
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
/** A repo with more members than this is not one anybody compiles. Bounded
    because 300 000 one-byte members fit in a 4MB request and cost ~400MB of Map. */
const MAX_MEMBERS = 20_000;
/** The longest member name worth honouring. A GNU long-name entry carries an
    unbounded string, and nothing legitimate needs more than this. */
const MAX_NAME = 1024;

/**
 * Is this member name one we will store?
 *
 * Refused: anything absolute, anything with a `..` segment, backslashes, NULs,
 * and anything absurdly long. NOT because a traversal currently escapes —
 * nothing writes these to disk, and `fileUrl` clamps `..` at the root — but
 * because that containment is incidental to code elsewhere, and a parser reading
 * attacker bytes should not depend on it. An absolute name also survives into
 * stored paths today, where `/a/b.malloy` and `a/b.malloy` collapse to the same
 * URL at serve time and row order decides which content the compiler sees.
 */
function safeName(name: string): boolean {
  if (!name || name.length > MAX_NAME) return false;
  if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return !name.split("/").some((seg) => seg === "..");
}

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
    // BOUNDED. Without maxOutputLength the default is buffer.kMaxLength, i.e.
    // none: a 4MB upload of compressed NULs expands past a gigabyte before any
    // of the caps below are consulted, because they are checked per member after
    // the whole archive is already in memory. Measured at 1029:1.
    buf = gunzipSync(gz, { maxOutputLength: MAX_TOTAL });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`archive expands past ${Math.round(MAX_TOTAL / 1024 / 1024)}MB`);
    }
    throw new Error(`not a gzipped archive: ${msg}`);
  }

  const raw = new Map<string, string>();
  const skipped: string[] = [];
  let total = 0;
  let offset = 0;
  // Set by an 'L' or 'x' entry, and consumed by the entry after it.
  let pendingName: string | null = null;
  // tar ends with two zero blocks. Without that marker the archive simply ran
  // out — which the loop below would otherwise treat as a clean finish, and a
  // repo missing its last files publishes as if it were whole.
  let terminated = false;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((b) => b === 0)) {
      terminated = true;
      break;
    }

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    // A truncated archive is an ERROR, not a short one. Returning what was read
    // publishes a repo missing files, and a missing dashboard is non-fatal
    // further up — so a half-downloaded tarball would silently delete dashboards
    // rather than fail.
    if (dataEnd > buf.length) throw new Error("archive is truncated");
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
      if (type === "x" && m) pendingName = m[1] ?? null;
      continue;
    }

    let name = pendingName ?? str(header, 0, 100);
    pendingName = null;
    if (!name) continue;
    // Unconditional: ustar splits a path into prefix + name and never repeats
    // the prefix inside the name, so a `startsWith` guard only mis-fires when a
    // name legitimately begins with its own prefix string — dropping it and
    // producing a wrong path.
    const prefix = str(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    // Regular file only. A NUL typeflag already read as "0" above; '5' is a
    // directory, and the rest (links, devices) have no meaning for a model repo.
    //
    // An EMPTY regular file is kept, deliberately. Dropping zero-length members
    // looked free — there are no bytes — and was not: the layout rules key on a
    // file EXISTING, not on what is in it. A `touch index.malloy`, a half-saved
    // file, an editor leaving a stub, and the dataset holding it stopped existing
    // as far as the server could see. `datasets/finance/index.malloy` empty meant
    // the repo published `sales` alone and reported success, which is the exact
    // half-publish `repo-layout.ts` refuses by name for every other cause. Worse,
    // it was not even recorded in `skipped`, so nothing could explain the gap.
    if (type !== "0") continue;

    if (!safeName(name)) {
      skipped.push(name);
      continue;
    }
    // Counted for EVERY member, kept or not: a name we skip still cost the
    // bytes, and only counting kept files made the rest free weight.
    total += size;
    if (total > MAX_TOTAL) {
      throw new Error(`archive exceeds ${Math.round(MAX_TOTAL / 1024 / 1024)}MB`);
    }
    if (raw.size >= MAX_MEMBERS) throw new Error(`archive holds more than ${MAX_MEMBERS} files`);
    if (!keepsFile(name) || size > MAX_FILE) {
      skipped.push(name);
      continue;
    }
    raw.set(name, buf.subarray(dataStart, dataEnd).toString("utf8"));
  }

  if (!terminated) throw new Error("archive is truncated");

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
    if (p === ENTRY_FILE || p === "malloy-config.json") return true;
    if (p.startsWith(`${DATASETS_DIR}/`)) return true;
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

// ── Packing ────────────────────────────────────────────────────────────────

/** An octal header field: NUL-terminated, zero-padded to `len`. The reader's
    `octal` above parses these; this one writes them. */
function octalField(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

/** Write `text` at `offset`. The explicit length picks one Buffer.write overload
    rather than leaving it to inference. */
function put(b: Buffer, offset: number, text: string): void {
  b.write(text, offset, Buffer.byteLength(text), "utf8");
}

/**
 * One entry: a ustar header with a correct checksum, then the data padded out to
 * a whole number of blocks.
 *
 * Paths over 100 bytes are split across the `prefix` field, which is what ustar
 * is for — `datasets/<name>/dashboards/<name>.malloy` passes 100 easily once the
 * names are real.
 */
function writeEntry(path: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // Split at a slash so both halves are whole path components.
    const cut = name.lastIndexOf("/", name.length - 1);
    let at = -1;
    for (let i = cut; i > 0; i = name.lastIndexOf("/", i - 1)) {
      if (Buffer.byteLength(name.slice(i + 1)) <= 100 && Buffer.byteLength(name.slice(0, i)) <= 155) {
        at = i;
        break;
      }
    }
    if (at === -1) {
      throw new Error(
        `path too long for a tar header: ${path}\n` +
          `Shorten a directory or file name; tar allows 100 bytes for the name and 155 for the path above it.`,
      );
    }
    prefix = name.slice(0, at);
    name = name.slice(at + 1);
  }

  const h = Buffer.alloc(BLOCK, 0);
  put(h, 0, name);
  put(h, 100, octalField(0o644, 8));
  put(h, 108, octalField(0, 8));
  put(h, 116, octalField(0, 8));
  put(h, 124, octalField(data.length, 12));
  put(h, 136, octalField(0, 12));
  put(h, 148, "        "); // the checksum field counts as spaces while summing
  put(h, 156, "0"); // regular file
  put(h, 257, "ustar\0");
  put(h, 263, "00");
  if (prefix) put(h, 345, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, octalField(sum, 8));

  const pad = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0);
  return Buffer.concat([h, data, pad]);
}

/** Pack repo-relative files into a gzipped tar. Sorted, so the same repo packs
    to the same bytes and a publish that changed nothing looks like it. */
export function buildTarGz(files: ReadonlyMap<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    parts.push(writeEntry(path, files.get(path)!));
  }
  // Two zero blocks end the archive.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts));
}

/** A `DirLister` over an extracted archive, for the layout rules. Both the
    GitHub refresh and the CLI repo push need exactly this. */
export function archiveLister(files: ReadonlyMap<string, string>): (path: string) => Promise<DirEntry[]> {
  return async (path: string) => archiveEntries(files, path);
}
