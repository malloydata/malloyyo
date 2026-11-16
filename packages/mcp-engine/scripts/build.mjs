// Build via esbuild's JS API (not the CLI bin shim, whose workspace layout can
// vary across installs — the API resolves the native binary reliably
// regardless).
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

// Chunk names are content hashes, so a stale chunk would otherwise linger.
rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts', 'src/core.ts', 'src/mcp-sdk.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  // index and core share modules (one help index, one set of surfaces), so
  // shared code goes to chunks both import rather than into each bundle.
  splitting: true,
  logLevel: 'info',
});
