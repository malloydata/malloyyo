// Bundle malloyyo_client.
//
// EVERYTHING is bundled, Malloy included, so the published package has ZERO
// runtime dependencies: `npm i` resolves one package instead of 51. That is the
// number this package exists for, and inlining the compiler is what takes it to
// the floor.
//
// Two outputs, and the split is load-bearing:
//
//   main.cjs   the whole client + engine + Malloy, in CJS.
//              CJS because Malloy does dynamic require() internally — an ESM
//              bundle builds fine and then dies at runtime with "Dynamic
//              require of X is not supported".
//
//   index.cjs  a ~5-line launcher that turns on V8's compile cache and THEN
//              requires main.cjs. It has to be a separate file: the cache only
//              helps modules compiled after it is enabled, so anything in the
//              same file as the heavy require is already too late.
//
// Measured on a 115KB compiled model: 460ms -> 387ms from the compile cache,
// and Malloy's import 275ms -> 177ms from bundling. Both are startup costs paid
// per invocation; see docs/local-client-dev.md for why that still loses to a
// warm process, and by how much.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { chmodSync, statSync } from 'node:fs';

const require = createRequire(import.meta.url);
const malloyVersion = require('@malloydata/malloy/package.json').version;
if (!malloyVersion) throw new Error('could not read the @malloydata/malloy version');

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/main.cjs',
  // Nothing external: that is the point. Malloy's version can no longer be
  // resolved from node_modules at runtime, so it is injected here — see
  // resolveMalloyVersion() in mcp-engine/src/model-blob.ts, whose runtime
  // fallback this constant folds away.
  define: {
    __MALLOY_VERSION__: JSON.stringify(malloyVersion),
    // The runtime fallback that reads it from node_modules is dead code here
    // (the constant above folds), but esbuild still parses its `import.meta.url`
    // and warns that import.meta is empty in CJS. Defining it keeps the build
    // output clean, so a future REAL warning is not lost in a known-benign one.
    'import.meta.url': JSON.stringify('file:///malloyyo-client-bundle'),
  },
  logLevel: 'info',
});

// The launcher is bundled separately and must stay TINY — it only pulls in
// src/daemon.ts, which imports nothing but Node builtins. If this output ever
// grows past a few KB, something from the heavy graph has leaked into it and
// the daemon fast path has quietly become as slow as a cold start.
await build({
  entryPoints: ['src/launcher.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.cjs',
  // The whole point: main.cjs is loaded at RUNTIME, only on a daemon miss.
  // Bundling it in would defeat the launcher's reason to exist.
  external: ['./main.cjs'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
chmodSync('dist/index.cjs', 0o755);

const launcherBytes = statSync('dist/index.cjs').size;
if (launcherBytes > 32 * 1024) {
  throw new Error(
    `dist/index.cjs is ${(launcherBytes / 1024).toFixed(0)}KB — the launcher must stay tiny ` +
      '(builtins only). Something heavy leaked into src/launcher.ts or src/daemon.ts, ' +
      'which would make every daemon hit pay a full bundle load.',
  );
}
console.log(`  dist/index.cjs  ${(launcherBytes / 1024).toFixed(1)}kb (thin launcher)`);
