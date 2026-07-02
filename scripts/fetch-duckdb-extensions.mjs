// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Pre-fetch DuckDB extensions at BUILD time so cold serverless instances (and
// read-only / air-gapped containers) never download them at query time.
//
// Why: DuckDB autoloads `httpfs` (~22 MB) from extensions.duckdb.org the first
// time a model reads an https/s3/gs URL. On Vercel each cold instance starts
// with an empty /tmp and re-pays that download — the dominant cost behind the
// 15–47s cold-query tail (warm instances that already have it are ~200ms).
//
// This script downloads the signed extension binaries for the DuckDB version
// and platform of the *installed* bindings (so build-arch == runtime-arch on
// Vercel and locally) into ./duckdb-extensions, plus a manifest. At runtime
// makeConnection() LOADs them by absolute path (see src/lib/malloy.ts) — a
// ~30ms local load, no network, no writable dir required.
//
// Non-fatal: if the CDN is unreachable at build time we warn and continue; the
// app falls back to DuckDB's normal autoload at query time.

import { DuckDBInstance } from "@duckdb/node-api";
import { gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Extensions to pre-bundle. httpfs covers https/s3/gs; add others here if models
// come to depend on them (spatial, json, icu, …).
const EXTENSIONS = ["httpfs"];

const CDN = "http://extensions.duckdb.org";
const OUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "duckdb-extensions");

async function detectEngine() {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const ver = (await (await conn.run("PRAGMA version")).getRows())[0][0]; // e.g. "v1.4.4"
  const platform = (await (await conn.run("PRAGMA platform")).getRows())[0][0]; // e.g. "linux_amd64"
  return { version: String(ver), platform: String(platform) };
}

async function main() {
  const { version, platform } = await detectEngine();
  const outDir = join(OUT_ROOT, version, platform);
  mkdirSync(outDir, { recursive: true });
  console.log(`[fetch-duckdb-extensions] engine ${version} / ${platform}`);

  const fetched = [];
  for (const name of EXTENSIONS) {
    const dest = join(outDir, `${name}.duckdb_extension`);
    if (existsSync(dest) && statSync(dest).size > 0) {
      console.log(`  ✓ ${name} already present (${statSync(dest).size} bytes) — skip`);
      fetched.push(name);
      continue;
    }
    const url = `${CDN}/${version}/${platform}/${name}.duckdb_extension.gz`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const gz = Buffer.from(await res.arrayBuffer());
      const bin = gunzipSync(gz);
      writeFileSync(dest, bin);
      console.log(`  ✓ ${name}: ${gz.length} B gz → ${bin.length} B → ${dest}`);
      fetched.push(name);
    } catch (err) {
      console.warn(`  ! ${name}: fetch failed (${err.message}); runtime autoload fallback will apply`);
    }
  }

  // Manifest the runtime reads to LOAD by path without re-detecting arch.
  const manifest = { version, platform, extensions: fetched };
  writeFileSync(join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[fetch-duckdb-extensions] wrote manifest: ${JSON.stringify(manifest)}`);
}

main().catch((err) => {
  // Never fail the build on this — autoload remains the fallback.
  console.warn(`[fetch-duckdb-extensions] skipped: ${err?.message ?? err}`);
});
