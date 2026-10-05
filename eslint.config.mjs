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
    "packages/cli/src/frame-inpage-entry.tsx",
    "packages/cli/src/frame-wasm-entry.tsx",
    "packages/cli/src/frame-runtime/**",
    // Browser shims aliased into those bundles (CJS, no types by design).
    "packages/cli/src/shims/**",
    "examples/**",
    // Test fixtures are INPUTS to the CLI's own checks, not source: v2-landing-broken
    // holds a deliberately unparseable landing page so lint.test.ts can prove the
    // parse error is reported. Linting them makes a fixture's whole purpose a build
    // failure.
    "packages/cli/test/fixtures/**",
    // Generated at build time (react + renderer vendor bundle for dashboards).
    "public/dashboard-vendor.js",
    // Its sibling, written by the same script (scripts/build-dashboard-vendor.mjs)
    // and gitignored on the next line of .gitignore. Omitting it meant a minified
    // vendor bundle was linted as source, which is why `server: lint` failed on a
    // working tree that had run the build.
    "public/mcp-app-sdk.js",
    // Agent worktrees: a nested CHECKOUT of this repo, build output and all.
    // `.next/**` above does not match a nested one, so a single leftover
    // worktree contributed 1578 files and ~159k problems to `npm run lint` —
    // enough to make preflight's lint step meaningless locally while telling CI
    // (which never has one) nothing. Not our source to lint under any pattern.
    ".claude/**",
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
