// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// bundleDashboard compiles a stored dashboard component (TSX) into the browser
// IIFE the frame and the MCP panel run — on esbuild-wasm, so these run the
// real compiler, not a stub.

import test from "node:test";
import assert from "node:assert/strict";
import { bundleDashboard } from "./bundle";

const DASHBOARD = `
import { useState } from "react";
import { useGiven, Controls } from "@malloyyo/dashboard";

type Props = { title?: string };

export default function Dashboard({ title = "Names" }: Props) {
  const [n, setN] = useState<number>(0);
  const [state] = useGiven("STATE");
  return (
    <div>
      <h1>{title} {String(state)}</h1>
      <Controls />
      <button onClick={() => setN(n + 1)}>{n}</button>
    </div>
  );
}
`;

test("compiles a TSX dashboard: types stripped, JSX + imports mapped to the vendor globals", async () => {
  const js = await bundleDashboard(DASHBOARD);
  assert.match(js, /__DASH_RUNTIME__\.mountDashboard/);
  assert.match(js, /__DASH_VENDOR__\.React/);
  assert.match(js, /__DASH_VENDOR__\.jsxRuntime/);
  assert.doesNotMatch(js, /: Props|<number>/, "TypeScript syntax must not survive");
  assert.doesNotMatch(js, /\bimport\s/, "the IIFE resolves every import");
});

test("an empty source mounts the runtime's default dashboard", async () => {
  const js = await bundleDashboard("");
  assert.match(js, /mountDashboard/);
});

test("a syntax error rejects with esbuild's message and line", async () => {
  await assert.rejects(bundleDashboard("export default function D() {\n  return <div>\n}\n"), (e: {
    errors?: Array<{ text: string; location?: { line: number } }>;
  }) => {
    assert.ok(e.errors?.[0]?.text, "an error message");
    assert.ok((e.errors?.[0]?.location?.line ?? 0) >= 2, "a line number");
    return true;
  });
});

test("importing something the runtime does not export fails the bundle", async () => {
  await assert.rejects(
    bundleDashboard(`import { Panel } from "@malloyyo/dashboard";\nexport default Panel;\n`),
    (e: { errors?: Array<{ text: string }> }) => /No matching export/.test(e.errors?.[0]?.text ?? ""),
  );
});
