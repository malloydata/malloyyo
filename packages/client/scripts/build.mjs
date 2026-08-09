// Bundle malloyyo_client. The point of this package is its install weight, so
// the externals list is the contract: ONLY @malloydata/malloy stays external
// (it is the real runtime dependency — the compiler). @malloyyo/mcp-engine is
// bundled IN, which costs nothing because the engine has no dependencies of its
// own, and buys the client the server's exact tool implementations.
//
// scripts/weigh.mjs asserts the resulting install stays small; if you add an
// external here, add it to package.json dependencies and expect weigh to argue.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  external: ['@malloydata/malloy', '@malloydata/malloy/internal'],
  // No shebang banner: src/index.ts carries its own (so `tsx src/index.ts`
  // works in dev) and esbuild preserves it. Adding one here yields two.
  logLevel: 'info',
});
