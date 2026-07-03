// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { LtoolApp } from "@/components/LtoolApp";
import { loadSharedQuery } from "@/lib/mcp-tools";

export default async function LtoolSharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Resolve the shared query's source up front so the sidebar's source filter
  // is seeded on the first render — otherwise the list flashes "all" before the
  // client-side share fetch narrows it.
  const res = await loadSharedQuery(slug).catch(() => null);
  const initialSource = res?.ok ? res.source ?? undefined : undefined;
  return <LtoolApp initialSlug={slug} initialSource={initialSource} />;
}
