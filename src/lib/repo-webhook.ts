// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * What a GitHub push does to a repo.
 *
 * Shared by the repo-scoped webhook (`/api/repos/:id/webhook/github`, the one to
 * configure) and the dataset-scoped one that predates it
 * (`/api/datasets/:id/webhook/github`), which is kept working because the URLs
 * are already in people's GitHub settings. Both end here, so there is one
 * answer to "what does a push do" rather than two that drift.
 *
 * NOBODY IS READING AN EXIT CODE. A webhook refusal has no caller, so the log is
 * the whole signal and it is written at `error` on purpose.
 */

import { captureTelemetry } from "./telemetry";
import { logger, serializeErr } from "./logger";
import { refreshRepo } from "./github-refresh";

function telemetry(outcome: "success" | "error") {
  return captureTelemetry({
    event: "model published",
    properties: {
      method: "github_webhook",
      outcome,
      created_dataset: false,
      source_count: 0,
      file_count: 0,
      dashboard_count: 0,
    },
  });
}

/** Refresh a repo on a push, reporting through the log. Never throws. */
export async function handleRepoPush(repoId: string, slug: string): Promise<void> {
  try {
    const result = await refreshRepo(repoId);
    if (!result.ok) {
      logger.error("webhook: repo revision was NOT activated", {
        repo: slug,
        kind: result.kind,
        revision: result.revisionId,
        error: result.error,
        failures: result.failures,
      });
      await telemetry("error");
      return;
    }
    if (result.unchanged) {
      logger.info("webhook: repo already at these bytes", { repo: slug, revision: result.revision });
      await telemetry("success");
      return;
    }
    if (result.unpublished.length > 0) {
      logger.warn("repo no longer publishes these datasets; they were left untouched", {
        repo: slug,
        unpublished: result.unpublished.map((u) => `${u.name} (${u.dir || "root"})`),
      });
    }
    if (result.unclaimed.length > 0) {
      logger.warn("repo publishes directories no dataset covers — add them to create them", {
        repo: slug,
        unclaimed: result.unclaimed.map((u) => u.dir),
      });
    }
    logger.info("webhook: repo revision live", {
      repo: slug,
      revision: result.revision,
      sha: result.sha,
      datasets: result.datasets.map((d) => d.qualified),
    });
    await telemetry("success");
  } catch (err) {
    logger.error("webhook refresh failed", { repo: slug, ...serializeErr(err) });
    await telemetry("error").catch(() => {});
  }
}
