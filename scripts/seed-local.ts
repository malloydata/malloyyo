// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Seed a local instance with a user, a dataset, and an MCP bearer token, so a
// dev server can be driven over /mcp without a Google sign-in and without the
// browser OAuth dance.
//
//   npx tsx scripts/seed-local.ts <model-dir> [dataset-name]
//
// The token it prints is a REAL access token (the same rows the OAuth flow
// writes), so it exercises the genuine auth path — validateAccessToken, the
// allow-list re-check, token-use recording — rather than bypassing it. For
// local development only: it mints credentials without proving identity, which
// is exactly what you do not want anywhere else.
import fs from "node:fs";
import path from "node:path";
import { db, users, datasets, malloyModels, malloyModelFiles } from "@/db";
import { issueTokenPair } from "@/lib/oauth/tokens";
import { oauthClients } from "@/db/schema";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npx tsx scripts/seed-local.ts <model-dir> [dataset-name]");
  process.exit(2);
}
const root = path.resolve(dir);
const name = process.argv[3] ?? path.basename(root);

const entry = path.join(root, "index.malloy");
if (!fs.existsSync(entry)) {
  console.error(`no index.malloy in ${root}`);
  process.exit(2);
}

// Every .malloy in the tree, so imports resolve exactly as a publish would.
function malloyFiles(base: string): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".malloy")) {
        out.push({ rel: path.relative(base, p), text: fs.readFileSync(p, "utf8") });
      }
    }
  };
  walk(base);
  return out;
}

async function main(): Promise<void> {
  const email = process.env.SEED_EMAIL ?? "dev@localhost";
  const [user] = await db.insert(users).values({ email, slug: "dev" }).returning();

  const [ds] = await db
    .insert(datasets)
    .values({ userId: user!.id, name, status: "ready", isPublic: false })
    .returning();

  const files = malloyFiles(root);
  const [model] = await db
    .insert(malloyModels)
    .values({
      datasetId: ds!.id,
      version: 1,
      source: files.find((f) => f.rel === "index.malloy")!.text,
      generatedBy: "seed-local",
      compiledAt: new Date(),
    })
    .returning();

  for (const f of files) {
    await db.insert(malloyModelFiles).values({ modelId: model!.id, path: f.rel, content: f.text });
  }

  const [client] = await db
    .insert(oauthClients)
    .values({
      name: "local dev",
      redirectUris: ["http://localhost/cb"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    })
    .returning();

  const { accessToken } = await issueTokenPair({
    clientId: client!.id,
    userId: user!.id,
    scope: "mcp",
    resource: null,
  });

  console.log(
    [
      `seeded user    ${email}`,
      `seeded dataset ${name} (${files.length} .malloy file(s))`,
      ``,
      `export MCP_TOKEN=${accessToken}`,
    ].join("\n"),
  );
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
