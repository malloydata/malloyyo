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
// `shims/` and frame-wasm-entry.tsx belong to the same set: `dashboard bundle`
// aliases assert/util to the shims when it builds the static site, and those
// paths are resolved next to the runtime just like the other entries.
// `shared/` holds code used by BOTH the node CLI and the browser bundles
// (givens-url). The node side gets it inlined by esbuild into dist/index.js;
// the browser side resolves it from disk next to the entry, so it must be
// copied like the rest of the frame source.
const items = [
  "frame-runtime",
  "frame-entry.tsx",
  "frame-inpage-entry.tsx",
  "frame-wasm-entry.tsx",
  "shims",
  "shared",
];

for (const item of items) {
  const from = path.join(src, item);
  const to = path.join(dist, item);
  if (!fs.existsSync(from)) throw new Error(`copy-frame-src: missing ${from}`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

console.log(`copied frame source into dist/ (${items.join(", ")})`);
