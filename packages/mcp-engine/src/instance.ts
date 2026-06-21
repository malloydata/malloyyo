// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Instance-name embedding. The engine is deliberately instance-agnostic — it
// never reads env and the content tree (gen-embedded at build time) can't know
// which deployment is serving it. So engine-authored text that wants to name
// the instance writes a literal placeholder, and the HOST — which knows its
// env.INSTANCE_NAME — substitutes it when it serves the instructions. This is
// the same seam the host already uses to tag tool descriptions ([INSTANCE]);
// here it renders prose.
//
// gen embeds content via JSON.stringify, so the placeholder is plain literal
// text in the .md (no template interpolation / eval) — it survives the build
// untouched and is replaced only at serve time.

/** The literal token engine content/instructions use where the instance name
    belongs. A host renders it with {@link renderInstructions}. Chosen to be
    obviously-not-prose and `$`-free (no backtick-template footgun). */
export const INSTANCE_PLACEHOLDER = '{{INSTANCE_NAME}}';

/** Substitute every {@link INSTANCE_PLACEHOLDER} in `text` with `instanceName`.
    Idempotent and a no-op when the text carries no placeholder, so a host can
    always call it. Hosts should run rendered instructions/descriptions through
    this before they reach the wire so no `{{INSTANCE_NAME}}` ever leaks. */
export function renderInstructions(text: string, instanceName: string): string {
  return text.replaceAll(INSTANCE_PLACEHOLDER, instanceName);
}
