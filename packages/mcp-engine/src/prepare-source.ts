// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Reader conventions: the host builds the Runtime; this builds what the
// host builds it FROM. Layers caching (so source text is re-readable for
// body slicing) and inline-source serving (virtual URL, or resolved against
// baseUrl so relative imports work) over a host-supplied base reader.
// The library itself never reads fs or DB.

import path from 'node:path';
import url from 'node:url';
import type { URLReader } from '@malloydata/malloy';

export type SourceInput =
  | { url: string }
  | { source: string; baseUrl?: string };

export interface PreparedSource {
  reader: URLReader;
  entry: URL;
  readSource: (href: string) => string | undefined;
}

const VIRTUAL_BASE = 'memory://mcp-engine/';

/** Accept bare filesystem paths for convenience; convert to file:// URLs. */
function normalizeUrl(u: string): URL {
  if (u.includes('://')) return new URL(u);
  return url.pathToFileURL(path.resolve(u));
}

function inlineVirtualUrl(baseUrl?: string): URL {
  // If the caller gave a baseUrl, resolve next to it so relative imports work
  // the way they would in a real file. Otherwise use a purely virtual URL;
  // relative imports then fail with a clear error, as they should.
  if (baseUrl) return new URL('__inline__.malloy', normalizeUrl(baseUrl));
  return new URL(VIRTUAL_BASE + '__inline__.malloy');
}

export function prepareSource(base: URLReader, input: SourceInput): PreparedSource {
  const inline = 'source' in input;
  const entry = inline ? inlineVirtualUrl(input.baseUrl) : normalizeUrl(input.url);
  const cache = new Map<string, string>();
  if (inline) cache.set(entry.href, input.source);

  const reader: URLReader = {
    readURL: async (u: URL) => {
      const cached = cache.get(u.href);
      if (cached !== undefined) return cached;
      const text = await base.readURL(u);
      const str = typeof text === 'string' ? text : String(text);
      cache.set(u.href, str);
      return str;
    },
  };
  return { reader, entry, readSource: (href) => cache.get(href) };
}
