// Build via esbuild's JS API (not the CLI bin shim, which pnpm lays out
// inconsistently across installs — the API resolves the native binary
// reliably regardless).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/mcp-sdk.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  logLevel: 'info',
});
