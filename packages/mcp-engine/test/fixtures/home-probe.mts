// Child process for duckdb-home.test.ts: opens a real Malloy DuckDB connection
// the way a malloyyo server does, with whatever HOME the parent handed it.
//
// Opening the connection loads DuckDB's bundled extension set (json, httpfs,
// icu), which is where a broken home directory actually bites: DuckDB resolves
// its extension store from $HOME and fails with
//
//     IO Error: Can't find the home directory at '…'
//
// so httpfs never loads and every model that reads an https:// or s3:// source
// fails later, far from the cause. No network is needed to provoke it — the
// home lookup happens before any download — which keeps the test hermetic.
//
// Run with `fix` to call ensureWritableHome() first. Prints `HOME <dir>` on
// stdout; DuckDB's own complaints go to stderr, which is what the test reads.
import { DuckDBConnection } from '@malloydata/db-duckdb';

if (process.argv[2] === 'fix') {
  const { ensureWritableHome } = await import('../../src/duckdb-home');
  // accountHome: null rules out the real account home, so the test exercises
  // the temp-dir fallback and writes nothing outside its own scratch dir.
  ensureWritableHome({ accountHome: null });
}

const conn = new DuckDBConnection({ name: 'duckdb' });
try {
  await conn.runSQL('SELECT 1 AS one');
  console.log(`HOME ${process.env['HOME']}`);
} finally {
  await conn.close();
}
