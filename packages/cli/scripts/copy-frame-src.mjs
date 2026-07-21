// `dashboard dev` bundles the frame at runtime with esbuild, reading the frame
// SOURCE from disk (see resolveRuntimeDir / resolveFrameEntry in dashboard.ts).
// The published package ships only `dist/**`, so copy that source into dist/ at
// build time — then resolveRuntimeDir's `./frame-runtime/` candidate (next to
// dist/index.js) resolves from a plain `npm i` install, not just a src checkout.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(cliRoot, "src");
const dist = path.join(cliRoot, "dist");

// Self-contained runtime set: frame-runtime/ has no imports outside itself, and
// the two entries import only "./frame-runtime/index" (+ the virtual dashboard).
const items = ["frame-runtime", "frame-entry.tsx", "frame-inpage-entry.tsx"];

for (const item of items) {
  const from = path.join(src, item);
  const to = path.join(dist, item);
  if (!fs.existsSync(from)) throw new Error(`copy-frame-src: missing ${from}`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

console.log(`copied frame source into dist/ (${items.join(", ")})`);
