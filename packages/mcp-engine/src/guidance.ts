// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The guidance canon — "how to write Malloy over MCP" is engine content:
// one voice, every host, every layer. These blocks feed the per-surface
// server instructions and are exported standalone so custom layer-2 surfaces
// building custom tools inherit the same rules. Host policy (question
// recording, share links, summary formats, instance tags) is appended by
// hosts, never written here.
//
// The text lives as prose in content/prompts/{core,develop,explore}/
// instructions.md (the audit/edit surface) and is embedded at build time —
// see src/prompts.ts.
import { prompts } from './prompts';

export const guidance = {
  core: prompts.core.instructions,
  develop: prompts.develop.instructions,
  explore: prompts.explore.instructions,
} as const;

export function assembleInstructions(kind: 'develop' | 'explore' | 'both'): string {
  const parts =
    kind === 'both'
      ? [guidance.develop, guidance.explore, guidance.core]
      : kind === 'develop'
        ? [guidance.develop, guidance.core]
        : [guidance.explore, guidance.core];
  return parts.join('\n\n');
}
