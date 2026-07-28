// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { LtoolApp } from "@/components/LtoolApp";

/** The source a `run:` query targets — `run: order_items -> …` → `order_items`,
    backticked names included. A drill arrives as `?q=` with no `?source=` (the
    dashboard frame doesn't know the source name), and /api/run needs one. */
function sourceOf(malloy: string | undefined): string | undefined {
  if (!malloy) return undefined;
  const m = /^\s*run:\s*(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/.exec(malloy);
  return m ? (m[1] ?? m[2]) : undefined;
}

export default async function LtoolPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; dataset?: string; q?: string }>;
}) {
  const sp = await searchParams;
  // `q` is a complete Malloy query (a drill handed over from a dashboard tile).
  // It seeds the editor and auto-runs; without it `source` just opens a starter.
  return (
    <LtoolApp
      initialSource={sp.source ?? sourceOf(sp.q)}
      initialDatasetId={sp.dataset}
      initialMalloy={sp.q}
    />
  );
}
