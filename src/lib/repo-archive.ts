// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * A repo's bytes: reading them, bounding them, and putting them on a disk.
 *
 * ZIP IS THE STORED FORMAT. Not per-file rows in Postgres, which made "what is
 * in this repo" a question about a table rather than about the repo — and not
 * `.tar.gz`, because gzip is one stream and cannot be read partially. A zip has
 * a central directory with per-member offsets and independent deflate, so one
 * dataset's files can be read without inflating the rest, and every member's
 * UNCOMPRESSED size is known before anything is inflated. That last property is
 * what bounds a decompression bomb, and it is the reason the limits below can be
 * enforced rather than merely hoped for.
 *
 * NOTHING HERE IS HAND-ROLLED. The previous implementation wrote a tar reader
 * and writer to avoid a dependency; five bugs were found in them across three
 * reviews — an unbounded gunzip, silent truncation, a dropped ustar prefix,
 * missing path sanitisation, and empty members dropped before being recorded —
 * and all five were in the READER. So: `fflate` for zip and gzip, `tar-stream`
 * for the one tar shape that still has to be read (an older CLI's payload).
 * Both are host-side dependencies, where the engine's no-runtime-dependency rule
 * does not apply.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, unzipSync, zipSync } from "fflate";
import * as tar from "tar-stream";
import { logger } from "./logger";

/**
 * The limits, and what each one is protecting.
 *
 * A zip declares its members' uncompressed sizes in the central directory, so
 * every one of these is checked BEFORE a byte is inflated. The old tar reader
 * could only check after.
 */
export const ARCHIVE_LIMITS = {
  /** The compressed payload. A model repo is text; this is already generous. */
  maxArchiveBytes: 32 * 1024 * 1024,
  /** One file. A `.malloy` file this big is not a model. */
  maxFileBytes: 8 * 1024 * 1024,
  /** Everything, inflated. The bomb bound. */
  maxTotalBytes: 128 * 1024 * 1024,
  /** Members. A repo with more paths than this is not a model repo. */
  maxEntries: 20_000,
} as const;

export class ArchiveError extends Error {}

/**
 * A fixed timestamp for every stored member.
 *
 * fflate reads a Date in LOCAL time and the zip format only holds 1980-2099, so
 * this is a mid-year instant that lands inside the range from any timezone. It
 * exists so the stored bytes do not carry the pack time; the CONTENT HASH below
 * is what actually has to be stable, and it is computed over the file set rather
 * than over the container precisely so a zip header cannot affect it.
 */
const ZIP_EPOCH = new Date("1980-06-01T12:00:00Z");

/** `PK\x03\x04` — the local file header every non-empty zip starts with. */
function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** `\x1f\x8b` — gzip. */
function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Is this path safe to write under a directory we control?
 *
 * Absolute paths, `..` segments, Windows drive letters, backslashes and NUL all
 * escape or confuse the extraction root. Rejected rather than sanitised: a path
 * we had to rewrite is a path whose author meant something else, and silently
 * relocating their file is how `lint` and the server come to disagree about what
 * a repo contains.
 */
export function isSafeMemberPath(name: string): boolean {
  if (!name || name.length > 1024) return false;
  if (name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return !name.split("/").some((seg) => seg === ".." || seg === ".");
}

/**
 * The single top-level directory every member shares, if there is one.
 *
 * GitHub's zipball wraps everything in `<repo>-<sha>/` and the stored archive
 * has to be rooted at the repo, so that prefix comes off. But it is only ever
 * removed when the CALLER says the archive came from GitHub, never inferred:
 * a multi-dataset repo holding nothing but `datasets/` has a shared top-level
 * directory too, and inferring here silently ate it — which turned a perfectly
 * good repo into one with no `index.malloy` and no `datasets/` and a refusal
 * nobody could explain. A test caught it; the inference was the bug.
 */
export function commonRootPrefix(names: Iterable<string>): string | null {
  let root: string | null = null;
  let any = false;
  for (const name of names) {
    any = true;
    const slash = name.indexOf("/");
    if (slash <= 0) return null; // a file at the top level: no common root
    const seg = name.slice(0, slash);
    if (root === null) root = seg;
    else if (root !== seg) return null;
  }
  return any ? root : null;
}

export type ArchiveEntry = {
  /** Repo-relative, with GitHub's wrapper directory already stripped. */
  path: string;
  /** Directory members are kept: a dataset directory holding only files this
      system does not read still EXISTS, and the layout rules key on existence. */
  isDir: boolean;
  size: number;
};

/** A normalized repo archive: a zip, its hash, and what is in it. */
export type RepoArchive = {
  zip: Buffer;
  sha256: string;
  entries: ArchiveEntry[];
};

/**
 * THE CONTENT HASH — over the file set, not over the container.
 *
 * `archive_sha256` is what lets a webhook recognise bytes the instance already
 * serves instead of minting a revision per push, so it has to be stable across
 * everything that is not the content: the compression level, the member order,
 * the zip's timestamps, and the format the archive arrived in. A hash of the
 * zip bytes is stable across none of those.
 */
function contentHash(files: ReadonlyMap<string, Uint8Array>): string {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name)!;
    h.update(name);
    h.update("\0");
    h.update(String(bytes.length));
    h.update("\0");
    h.update(bytes);
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Read a zip, enforcing the limits, and hand back the member bytes.
 *
 * `unzipSync`'s filter runs per member with the sizes from the central
 * directory, so a refusal happens before inflation. The running total is
 * accumulated there for the same reason.
 */
function readZip(zip: Buffer): Map<string, Uint8Array> {
  if (zip.length > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ArchiveError(
      `the repo archive is ${(zip.length / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${ARCHIVE_LIMITS.maxArchiveBytes / 1024 / 1024}MB limit`,
    );
  }
  let total = 0;
  let count = 0;
  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(new Uint8Array(zip), {
      filter: (file) => {
        count += 1;
        if (count > ARCHIVE_LIMITS.maxEntries) {
          throw new ArchiveError(`the repo archive has more than ${ARCHIVE_LIMITS.maxEntries} entries`);
        }
        if (file.originalSize !== undefined && file.originalSize > ARCHIVE_LIMITS.maxFileBytes) {
          throw new ArchiveError(
            `${file.name} is ${(file.originalSize / 1024 / 1024).toFixed(1)}MB, over the ` +
              `${ARCHIVE_LIMITS.maxFileBytes / 1024 / 1024}MB per-file limit`,
          );
        }
        total += file.originalSize ?? 0;
        if (total > ARCHIVE_LIMITS.maxTotalBytes) {
          throw new ArchiveError(
            `the repo archive expands to more than ${ARCHIVE_LIMITS.maxTotalBytes / 1024 / 1024}MB`,
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(`could not read the repo archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Map(Object.entries(out));
}

/** Read an older CLI's `.tar.gz` payload into member bytes, same limits. */
async function readTarGz(gz: Buffer): Promise<Map<string, Uint8Array>> {
  if (gz.length > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ArchiveError(
      `the repo archive is ${(gz.length / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${ARCHIVE_LIMITS.maxArchiveBytes / 1024 / 1024}MB limit`,
    );
  }
  // gunzipSync allocates the whole inflated stream, so cap it. gzip cannot be
  // read partially — this is the format's cost, and the reason the STORED
  // archive is a zip.
  let plain: Uint8Array;
  try {
    plain = gunzipSync(new Uint8Array(gz), { out: new Uint8Array(ARCHIVE_LIMITS.maxTotalBytes) });
  } catch (err) {
    throw new ArchiveError(
      `could not decompress the repo archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const files = new Map<string, Uint8Array>();
  let total = 0;
  const extract = tar.extract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const name = header.name;
      const size = header.size ?? 0;
      if (header.type !== "file" && header.type !== "directory") {
        stream.resume();
        return next();
      }
      if (size > ARCHIVE_LIMITS.maxFileBytes) {
        stream.resume();
        return next(
          new ArchiveError(
            `${name} is ${(size / 1024 / 1024).toFixed(1)}MB, over the ` +
              `${ARCHIVE_LIMITS.maxFileBytes / 1024 / 1024}MB per-file limit`,
          ),
        );
      }
      total += size;
      if (total > ARCHIVE_LIMITS.maxTotalBytes) {
        stream.resume();
        return next(new ArchiveError("the repo archive expands past its limit"));
      }
      if (files.size >= ARCHIVE_LIMITS.maxEntries) {
        stream.resume();
        return next(new ArchiveError(`the repo archive has more than ${ARCHIVE_LIMITS.maxEntries} entries`));
      }
      if (header.type === "directory") {
        stream.resume();
        files.set(name.endsWith("/") ? name : `${name}/`, new Uint8Array(0));
        return next();
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c: unknown) => {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
      });
      stream.on("end", () => {
        // EMPTY FILES ARE KEPT. The old extractor dropped zero-length members
        // before recording them, so `touch datasets/finance/index.malloy` made
        // that dataset stop existing as far as the server was concerned — the
        // layout rules key on a file EXISTING, not on its contents.
        files.set(name, new Uint8Array(Buffer.concat(chunks)));
        next();
      });
      stream.on("error", next);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  Readable.from(Buffer.from(plain)).pipe(extract);
  await done;
  return files;
}

/**
 * Turn whatever arrived into the canonical stored form: a zip rooted at the repo.
 *
 * Both ways a repo reaches this server converge HERE, which is the structural
 * answer to "the server must read a repo the way the author's machine does".
 * GitHub's zipball needs only its wrapper directory removed; an older CLI's
 * tar.gz is read once and repacked. Everything downstream sees one format.
 */
export async function normalizeArchive(
  raw: Buffer,
  opts: {
    /**
     * Remove the single top-level directory every member shares.
     *
     * TRUE only for GitHub's zipball/tarball, which always wraps. The CLI's
     * archive is repo-rooted by construction, and a repo that happens to hold
     * one top-level directory must keep it (see `commonRootPrefix`).
     */
    stripWrapper?: boolean;
  } = {},
): Promise<RepoArchive> {
  const members = isZip(raw)
    ? readZip(raw)
    : isGzip(raw)
      ? await readTarGz(raw)
      : (() => {
          throw new ArchiveError("the repo archive is neither a zip nor a gzipped tar");
        })();

  if (members.size === 0) throw new ArchiveError("the repo archive is empty");

  const root = opts.stripWrapper ? commonRootPrefix(members.keys()) : null;
  const kept = new Map<string, Uint8Array>();
  const rejected: string[] = [];
  for (const [name, bytes] of members) {
    const rel = root ? name.slice(root.length + 1) : name;
    if (!rel) continue; // the wrapper directory itself
    if (!isSafeMemberPath(rel.endsWith("/") ? rel.slice(0, -1) : rel)) {
      rejected.push(name);
      continue;
    }
    kept.set(rel, bytes);
  }
  if (rejected.length > 0) {
    throw new ArchiveError(
      `the repo archive contains ${rejected.length} unsafe path(s) and was refused: ` +
        rejected.slice(0, 5).join(", "),
    );
  }
  if (kept.size === 0) throw new ArchiveError("the repo archive contains nothing under its root");

  // Repack even when the input was already a zip: the wrapper directory has to
  // come off, and a re-pack is also what makes `archive_sha256` a hash of the
  // CONTENT rather than of GitHub's framing (which embeds the sha, so two
  // identical trees would hash differently and a webhook could never recognise
  // bytes it already had).
  const toPack: Record<string, Uint8Array> = {};
  for (const [name, bytes] of [...kept].sort((a, b) => a[0].localeCompare(b[0]))) {
    toPack[name] = bytes;
  }
  // A FIXED mtime, so identical content hashes to one value. Without it the
  // hash carries the pack time and `archive_sha256` could never recognise bytes
  // the instance already serves - which is the whole reason a webhook storm does
  // not mint a revision per push. (fflate requires 1980-2099; zip's own epoch.)
  const zip = Buffer.from(zipSync(toPack, { level: 6, mtime: ZIP_EPOCH }));

  const entries: ArchiveEntry[] = [...kept]
    .map(([name, bytes]) => ({
      path: name.endsWith("/") ? name.slice(0, -1) : name,
      isDir: name.endsWith("/"),
      size: bytes.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { zip, sha256: contentHash(kept), entries };
}

/** Re-read a stored archive's listing without writing it anywhere. */
export function archiveEntryList(zip: Buffer): ArchiveEntry[] {
  const members = readZip(zip);
  return [...members]
    .map(([name, bytes]) => ({
      path: name.endsWith("/") ? name.slice(0, -1) : name,
      isDir: name.endsWith("/"),
      size: bytes.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Put a stored revision on a real disk.
 *
 * THE POINT IS THE FILESYSTEM. Every divergence the previous implementation was
 * reviewed for was between an in-memory file map on the server and a real
 * directory tree on the author's machine: `Dirent.isDirectory()` not following a
 * symlink the archive walker did follow, empty files dropped, directories
 * inferred only from the files that were kept, and a config search that checked
 * two locations where Malloy's own walks every intermediate one. Materializing
 * means the server compiles a filesystem, like the CLI does, with Malloy's own
 * config discovery over it — so there is one thing to be right about instead of
 * two things to keep in step.
 *
 * `/tmp` is the only writable path on Vercel, which is also where this has to
 * work.
 */
export function materializeArchive(zip: Buffer, label = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `malloyyo-${label.replace(/[^a-z0-9]+/gi, "-")}-`));
  const members = readZip(zip);
  let files = 0;
  for (const [name, bytes] of members) {
    const rel = name.endsWith("/") ? name.slice(0, -1) : name;
    // Checked again on the way out, not only on the way in: an archive stored
    // before this check existed must not be able to write outside the temp dir.
    if (!isSafeMemberPath(rel)) {
      throw new ArchiveError(`${name}: unsafe path in a stored archive`);
    }
    const abs = path.join(dir, rel);
    if (name.endsWith("/")) {
      fs.mkdirSync(abs, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    files += 1;
  }
  logger.debug("revision materialized", { dir, files, members: members.size });
  return dir;
}

/** Remove a materialized tree. Never throws — a leftover temp dir is not an outage. */
export function discardWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn("could not remove materialized repo", {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
