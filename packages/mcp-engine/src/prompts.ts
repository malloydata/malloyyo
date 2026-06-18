// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The single audit/edit surface for the engine's model-facing text — tool
// titles + descriptions and the per-surface server instructions. The text
// itself lives as plain markdown under content/prompts/**.md and is embedded
// at build time (scripts/embed-content.ts → src/content/generated.ts), so a
// human can review and edit every prompt as prose without reading TypeScript.
//
// One way in: the typed tree, `prompts.develop.tools.compile.description`.
// Literal-typed (`as const`), so a renamed or missing key is a COMPILE error —
// no stringly-keyed lookup that can fail at runtime.
import { prompts } from './content/generated';

export { prompts };
