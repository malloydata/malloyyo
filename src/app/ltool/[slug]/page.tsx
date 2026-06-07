// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { LtoolApp } from "@/components/LtoolApp";

export default async function LtoolSharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <LtoolApp initialSlug={slug} />;
}
