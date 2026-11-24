// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/datasets/:id/model/push` — RETIRED.
 *
 * This was the repo-less dataset push behind `malloyyo publish --dataset x`: a
 * file list written into a dataset that belonged to no repo, a second storage
 * path beside the repo one. Every publish is a repo now (`POST /api/repos/push`).
 * What is left answers the `malloyyo` binaries installed before that, so a CI
 * job on one fails with what to do rather than with a bare 404.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      kind: "request",
      error:
        "this malloyyo is too old for this instance: datasets are published as part of a repo now. " +
        "Upgrade (npm i -g @malloydata/malloyyo) and run `malloyyo publish` in the model's repo. " +
        "A dataset that is not in a repo yet is moved into one first, by an admin, on its page " +
        "(Move into a repo).",
    },
    { status: 410 },
  );
}
