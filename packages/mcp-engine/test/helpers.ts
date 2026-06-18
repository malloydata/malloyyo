// Test plumbing: hosts in miniature. A map-backed base URLReader (the
// library never reads fs — neither do these tests' readers), DuckDB-backed
// runtimes, and host implementations the way real hosts would write them.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SingleConnectionRuntime, type Runtime, type URLReader } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import {
  prepareSource,
  type DevelopHost,
  type BoundModel,
  type ExploreHost,
  type ModelList,
  type SourceInput,
} from '../src/index';

const here = path.dirname(url.fileURLToPath(import.meta.url));

export const FIXTURE_BASE = 'file:///fixture/';

/** Load test/fixtures/*.malloy into an href-keyed map under FIXTURE_BASE. */
export function fixtureFiles(): Map<string, string> {
  const dir = path.join(here, 'fixtures');
  const map = new Map<string, string>();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.malloy')) continue;
    map.set(FIXTURE_BASE + name, fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return map;
}

export function mapReader(files: Map<string, string>): URLReader {
  return {
    readURL: async (u: URL) => {
      const text = files.get(u.href);
      if (text === undefined) throw new Error(`not found: ${u.href}`);
      return text;
    },
  };
}

export function fixtureUrl(name: string): URL {
  return new URL(FIXTURE_BASE + name);
}

/** One runtime + connection, caller closes. */
export function makeRuntime(reader: URLReader): { runtime: Runtime; close: () => Promise<void> } {
  const connection = new DuckDBConnection({ name: 'duckdb' });
  const runtime = new SingleConnectionRuntime({ connection, urlReader: reader });
  return { runtime, close: () => connection.close() };
}

/** Lease-shaped helper for direct helper tests. */
export async function withFixtureRuntime<T>(
  fn: (runtime: Runtime) => Promise<T>,
): Promise<T> {
  const { runtime, close } = makeRuntime(mapReader(fixtureFiles()));
  try {
    return await fn(runtime);
  } finally {
    await close();
  }
}

/** An DevelopHost the way the fox CLI would write one. */
export function testDevelopHost(): DevelopHost {
  const files = fixtureFiles();
  return {
    async withRuntime<T>(input: SourceInput, fn: (m: BoundModel) => Promise<T>): Promise<T> {
      const { reader, entry, readSource } = prepareSource(mapReader(files), input);
      const { runtime, close } = makeRuntime(reader);
      try {
        return await fn({ runtime, entry, readSource });
      } finally {
        await close();
      }
    },
  };
}

/** A ExploreHost over the fixture "catalog": ref = fixture file name. */
export function testExploreHost(opts: { withList?: boolean } = {}): ExploreHost {
  const files = fixtureFiles();
  const host: ExploreHost = {
    async withModel<T>(ref: string, fn: (m: BoundModel) => Promise<T>): Promise<T> {
      const href = FIXTURE_BASE + ref;
      if (!files.has(href)) throw new Error(`no published model '${ref}'`);
      const { reader, entry, readSource } = prepareSource(mapReader(files), {
        url: href,
      });
      const { runtime, close } = makeRuntime(reader);
      try {
        return await fn({ runtime, entry, readSource });
      } finally {
        await close();
      }
    },
  };
  if (opts.withList) {
    host.list = async (): Promise<ModelList> => ({
      entries: [...files.keys()].sort().map((href) => ({
        model_ref: href.slice(FIXTURE_BASE.length),
        description: null,
      })),
    });
  }
  return host;
}

// ── golden files ───────────────────────────────────────────────────

export function checkGolden(name: string, value: unknown): { expected: string; actual: string } {
  const file = path.join(here, 'golden', name);
  const actual = JSON.stringify(value, null, 2) + '\n';
  if (process.env['UPDATE_GOLDENS'] === '1' || !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
    return { expected: actual, actual };
  }
  return { expected: fs.readFileSync(file, 'utf8'), actual };
}
