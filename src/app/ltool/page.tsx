// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { LtoolApp } from "@/components/LtoolApp";

export default async function LtoolPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; dataset?: string }>;
}) {
  const sp = await searchParams;
  return <LtoolApp initialSource={sp.source} initialDatasetId={sp.dataset} />;
}
