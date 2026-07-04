// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated build output (gitignored bundles) — never our source to lint.
    "**/dist/**",
    // Browser runtime for dashboard artifacts: bundled at runtime by esbuild,
    // not part of the app/CLI TS build (needs @ts-nocheck, different React
    // constraints). Includes the CLI frame runtime and example dashboards.
    "packages/cli/src/frame-entry.tsx",
    "examples/**",
  ]),
  {
    // Honor the `_`-prefix convention for deliberately-unused bindings
    // (e.g. `const { [HOST_ONLY]: _hostOnly, ...rest } = x` to omit a key).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
