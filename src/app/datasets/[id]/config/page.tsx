// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `/datasets/<id>/config` — for a dataset no repo publishes.
 *
 * When a repo does publish it, this redirects there. Almost everything this page
 * offered has moved: the GitHub settings and refresh belong to the repo, "did my
 * publish work" is the repo's revision list, visibility is a role grant, and the
 * model being shown came from a revision rather than from this dataset. What was
 * left was a second place to look for answers the repo page gives better.
 *
 * Still a real page for a dataset with no repo — one made before the repo model,
 * or published with `--dataset x`. For those it is the only place anything lives,
 * so nothing is taken away.
 *
 * Server component purely for the redirect: deciding on the client means
 * rendering the old page first and yanking it away.
 */

import { redirect } from "next/navigation";
import { resolveDatasetRef } from "@/lib/repos";
import { resolveAccess, rolesOf } from "@/lib/roles";
import { getSessionUserOrNull } from "@/lib/user";
import { DatasetConfig } from "./dataset-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Resolved the same way every other surface resolves one — a uuid,
  // `repo:dataset`, an alias, or a bare name — so a link that worked before the
  // rename still lands here. It already carries the repo, so this needs no query
  // of its own.
  //
  // ONLY FOR SOMEONE WHO CAN OPEN IT. The redirect below names the repo that
  // publishes a dataset, and this page used to do it for any browser holding a
  // session cookie: someone with no access, or still waiting for approval,
  // could ask about any dataset name and learn that it exists and where it
  // comes from. Everyone else falls through to the page, whose own request
  // answers "not found".
  const me = await getSessionUserOrNull();
  const ref = me ? await resolveDatasetRef(id) : null;
  if (me && ref?.ok && ref.repo) {
    const { dataset } = ref;
    const level = resolveAccess(rolesOf(me), [{ ...dataset, ownerId: dataset.userId }], { userId: me.id })[0].level;
    if (level !== "none") redirect(`/repos/${encodeURIComponent(ref.repo.slug)}`);
  }

  // Not found, ambiguous, or simply has no repo: let the page itself say so,
  // the way it always did.
  return <DatasetConfig id={id} />;
}
