// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where an instance is in guided setup — one answer, read by the setup page,
// its API, the home page's empty state and the setup_status MCP tool, so Claude
// and the person never see two different stories.
//
// DB and env only (no Malloy): safe for pages.

import { count, eq } from "drizzle-orm";
import { db, datasets, repos } from "@/db";
import { env } from "./env";
import { envPresence, instancePlatform, manualInstructions, type Platform } from "./instance-platform";
import { CONNECTION_KINDS, KIND_SPECS } from "./connection-kinds";

export type SetupStatus = {
  instance: string;
  platform: Platform;
  /** How this platform takes a secret: set from the setup page, or by the operator. */
  secretsHow: string;
  authoring: boolean;
  datasets: number;
  repos: Array<{ id: string; slug: string; github: string | null; webhookUrl: string }>;
  github: { tokenSet: boolean; webhookSecretSet: boolean };
  links: {
    setup: string;
    authoring: string;
    /** Fill in `{kind}` (motherduck|bigquery|postgres) and `{name}` (e.g. warehouse). */
    connection: string;
    /** Fill in `{repo}` (owner/name). */
    github: string;
    mcp: string;
  };
  connectionKinds: Array<{ kind: string; label: string; needs: string }>;
};

export async function setupStatus(): Promise<SetupStatus> {
  const base = env.APP_BASE_URL.replace(/\/$/, "");
  const platform = instancePlatform();
  const [{ n }] = await db.select({ n: count() }).from(datasets).where(eq(datasets.status, "ready"));
  const repoRows = await db.select({ id: repos.id, slug: repos.slug, github: repos.githubRepo }).from(repos);
  const present = envPresence(["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET"]);
  return {
    instance: env.INSTANCE_NAME,
    platform,
    secretsHow:
      platform === "cloud"
        ? "Malloyyo Cloud: the setup page saves secrets for you; the instance restarts (about a minute) to pick them up."
        : platform === "dev"
          ? "Local dev server: the setup page saves secrets for you (into its dev secrets file); they take effect at once."
        : manualInstructions(platform, ["the variables the page names"]),
    authoring: env.REPO_AUTHORING,
    datasets: Number(n),
    repos: repoRows.map((r) => ({ ...r, webhookUrl: `${base}/api/repos/${r.id}/webhook/github` })),
    github: { tokenSet: present.GITHUB_TOKEN, webhookSecretSet: present.GITHUB_WEBHOOK_SECRET },
    links: {
      setup: `${base}/admin/setup`,
      authoring: `${base}/admin/setup?step=authoring`,
      connection: `${base}/admin/setup?step=connection&kind={kind}&name={name}`,
      github: `${base}/admin/setup?step=github&repo={repo}`,
      mcp: `${base}/mcp`,
    },
    connectionKinds: CONNECTION_KINDS.map((k) => ({ kind: k, label: KIND_SPECS[k].label, needs: KIND_SPECS[k].needs })),
  };
}
