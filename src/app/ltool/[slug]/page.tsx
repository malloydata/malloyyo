// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { LtoolApp } from "@/components/LtoolApp";
import { isAdmin } from "@/lib/admin";
import { loadSharedQuery, maySeeSharedQuery } from "@/lib/mcp-tools";
import { rolesOf } from "@/lib/roles";
import { getSessionUserOrNull } from "@/lib/user";

export default async function LtoolSharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Resolve the shared query's source up front so the sidebar's source filter
  // is seeded on the first render — otherwise the list flashes "all" before the
  // client-side share fetch narrows it.
  //
  // ONLY FOR SOMEONE WHO MAY SEE THE QUERY. This used to look the slug up for
  // any browser holding a session cookie — which includes people waiting for
  // approval, and members with no access to the dataset — and put the source
  // name of a private dataset's query in the page. The proxy checks that a
  // session exists, not who it is; this page has to.
  const user = await getSessionUserOrNull();
  let initialSource: string | undefined;
  if (user) {
    const res = await loadSharedQuery(slug).catch(() => null);
    const viewer = { id: user.id, roles: rolesOf(user), admin: isAdmin(user) };
    if (res?.ok && (await maySeeSharedQuery(viewer, slug, res.datasetId))) {
      initialSource = res.source ?? undefined;
    }
  }
  return <LtoolApp initialSlug={slug} initialSource={initialSource} />;
}
