// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Guided setup's page: turn authoring on, add a database connection, connect
// GitHub. Claude sends people here with a step and its parameters in the URL
// (yo_help "setup/start"); everything the page does is also usable on its own.

import { requireAdminPage } from "@/lib/admin";
import { KIND_SPECS, CONNECTION_KINDS } from "@/lib/connection-kinds";
import { manualInstructions } from "@/lib/instance-platform";
import { setupStatus } from "@/lib/setup-status";
import SetupClient from "./SetupClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const status = await setupStatus();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  return (
    <SetupClient
      status={status}
      kinds={CONNECTION_KINDS.map((k) => ({ kind: k, ...KIND_SPECS[k] }))}
      manual={{
        authoring: manualInstructions(status.platform, ["REPO_AUTHORING=1"]),
        github: manualInstructions(status.platform, ["GITHUB_TOKEN"]),
        webhook: manualInstructions(status.platform, ["GITHUB_WEBHOOK_SECRET"]),
        connection: manualInstructions(status.platform, ["{names}"]),
      }}
      initial={{
        step: one("step"),
        kind: one("kind"),
        name: one("name"),
        repo: one("repo"),
        // Non-secret settings Claude already has (host, project id…) prefill the
        // form; a secret is never taken from a URL.
        settings: Object.fromEntries(
          CONNECTION_KINDS.flatMap((k) => KIND_SPECS[k].fields)
            .filter((f) => !f.secret && one(f.key))
            .map((f) => [f.key, one(f.key)]),
        ),
      }}
    />
  );
}
