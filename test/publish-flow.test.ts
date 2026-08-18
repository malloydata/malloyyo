// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Integration test for the PUBLISH flow: the real `malloyyo` CLI binary → HTTP →
// the real route handlers (`/api/datasets/:ref/model/{push,status}`) → a real
// Postgres, with the model compiled by real Malloy on in-process DuckDB.
//
// "Bring up a test Malloyyo server" here means mounting the actual Next route
// handlers on a node:http listener (bootServer below) rather than running
// `next build && next start`: same handler code, same wire contract, seconds
// instead of minutes, and no Next server runtime to keep alive. Everything the
// publish path touches — CLI gather/lint, bearer auth, compile, the create +
// version transaction — is the production code.
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres,
// applies the schema, builds the CLI, and points DATABASE_URL at it).

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  users,
  datasets,
  malloyModels,
  malloyModelFiles,
  malloyArtifacts,
  oauthClients,
  oauthAccessTokens,
  type User,
} from "@/db";
import { POST as pushRoute } from "@/app/api/datasets/[id]/model/push/route";
import { GET as statusRoute } from "@/app/api/datasets/[id]/model/status/route";

// Everything this test creates is suffixed with a per-run id, and torn down in
// after(): the suite is re-runnable against a database that already has rows,
// and leaves none of its own behind (scripts/hosted-test.sh resets the schema
// anyway — this makes a hand-run `tsx --test` just as safe).
const RUN = randomBytes(3).toString("hex");
const DS_MAIN = `petshop_cli_${RUN}`;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The published artifact, not the sources: this is what `npm i -g @malloydata/malloyyo`
// installs, so the test exercises the same bundle users run.
const CLI = process.env.MALLOYYO_CLI_BIN ?? join(REPO_ROOT, "packages/cli/dist/index.js");

// ── a test Malloyyo server ────────────────────────────────────────────────────

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const ROUTES: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: "POST", pattern: /^\/api\/datasets\/([^/]+)\/model\/push$/, handler: pushRoute },
  { method: "GET", pattern: /^\/api\/datasets\/([^/]+)\/model\/status$/, handler: statusRoute },
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Mount the route handlers on an ephemeral port; returns the base URL. */
async function bootServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!route) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no route" }));
          return;
        }
        const id = decodeURIComponent(route.pattern.exec(url.pathname)![1]);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
          else if (Array.isArray(v)) for (const one of v) headers.append(k, one);
        }
        const raw = await readBody(req);
        const request = new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
          body: raw.length > 0 ? new Uint8Array(raw) : undefined,
        });
        const response = await route.handler(request, { params: Promise.resolve({ id }) });
        const out = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
        res.end(out);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

// ── the CLI, as a user runs it ───────────────────────────────────────────────

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const MODEL = `#" Pet shop sales.
source: sales is duckdb.sql("""
  SELECT 'dog' as animal, 'CA' as state, 2 as qty
  UNION ALL SELECT 'cat', 'CA', 3
  UNION ALL SELECT 'dog', 'OR', 1
""") extend {
  measure: total_qty is qty.sum()
  #" Units sold per animal.
  view: by_animal is { group_by: animal; aggregate: total_qty }
  view: totals is { aggregate: total_qty }
}
`;

// Rides along as a model file AND becomes a dashboard artifact, so the test
// covers the whole payload the CLI sends, not just the .malloy sources.
const DASHBOARD = `import { sales } from "../index.malloy"
## artifact { title="Totals" tiles=["sales -> by_animal", "sales -> totals"] dashboard_columns=2 }
`;

// A model that compiles nowhere: proves a rejected publish creates no dataset.
const BROKEN = `source: sales is duckdb.sql("SELECT 1 as one") extend {
  view: nope is { group_by: column_that_does_not_exist }
}
`;

let serverUrl: string;
let server: Server;
let admin: User;
let token: string;
let clientId: string;
/** Users seeded here; deleting them cascades to their datasets and models. */
const seededUsers: string[] = [];
/** Publish dirs made by makeProject(), cleaned up in after(). */
const projects: string[] = [];

/** A publishable model directory whose malloyyo target points at the test server. */
function makeProject(dataset: string, opts: { model?: string; dashboard?: boolean } = {}): string {
  // In os.tmpdir(), NOT the repo: gatherDirectory's git probe would otherwise
  // stamp this repo's commit onto the payload and make assertions drift.
  const dir = mkdtempSync(join(tmpdir(), "malloyyo-publish-"));
  projects.push(dir);
  writeFileSync(
    join(dir, "malloy-config.json"),
    JSON.stringify(
      {
        connections: { duckdb: { is: "duckdb" } },
        malloyyo: { targets: { test: { url: serverUrl, dataset } } },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "index.malloy"), opts.model ?? MODEL);
  if (opts.dashboard) {
    mkdirSync(join(dir, "dashboards"));
    writeFileSync(join(dir, "dashboards", "totals.malloy"), DASHBOARD);
  }
  return dir;
}

async function datasetRows(name: string) {
  return db.select().from(datasets).where(eq(datasets.name, name));
}

async function models(datasetId: string) {
  return db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, datasetId))
    .orderBy(desc(malloyModels.version));
}

before(async () => {
  assert.ok(
    existsSync(CLI),
    `malloyyo CLI not built at ${CLI} — run \`npm run build -w packages/cli\` (scripts/hosted-test.sh does this for you)`,
  );

  const [u] = await db
    .insert(users)
    .values({ email: `publisher-${RUN}@test.local`, slug: `publisher-${RUN}`, isAdmin: true })
    .returning();
  admin = u;
  seededUsers.push(u.id);

  // A real bearer token, minted the way the OAuth route mints one: the server
  // validates it against oauth_access_tokens, so auth is exercised for real.
  const [client] = await db
    .insert(oauthClients)
    .values({
      name: `publish-flow-test-${RUN}`,
      redirectUris: ["http://127.0.0.1/cb"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
    })
    .returning();
  clientId = client.id;
  token = randomBytes(32).toString("base64url");
  await db.insert(oauthAccessTokens).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    clientId: client.id,
    userId: admin.id,
    scope: "mcp",
    resource: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  ({ url: serverUrl, server } = await bootServer());
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
  // Cascades: users → datasets → models/files/artifacts, client → tokens.
  for (const id of seededUsers) await db.delete(users).where(eq(users.id, id));
  if (clientId) await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
});

// ── tests ────────────────────────────────────────────────────────────────────

test("publish to a missing dataset fails, creates nothing, and points at --create-dataset", async () => {
  const dir = makeProject(`ghost_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", token], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, new RegExp(`dataset "ghost_ds_${RUN}" not found`));
  assert.match(out, /--create-dataset/);
  assert.equal((await datasetRows(`ghost_ds_${RUN}`)).length, 0);
});

test("publish --create-dataset creates a private dataset owned by the token's user, with v1", async () => {
  const dir = makeProject(DS_MAIN, { dashboard: true });
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`created dataset ${DS_MAIN} \\(private\\)`));
  assert.match(r.stdout, /published version 1/);

  const rows = await datasetRows(DS_MAIN);
  assert.equal(rows.length, 1);
  const ds = rows[0];
  assert.equal(ds.status, "ready");
  assert.equal(ds.isPublic, false, "a CLI-created dataset must not be public");
  assert.equal(ds.userId, admin.id);
  assert.ok(ds.readyAt);
  assert.equal(ds.lastPublishError, null);
  assert.ok(ds.lastPublishAt);

  const [model] = await models(ds.id);
  assert.equal(model.version, 1);
  assert.deepEqual(
    (model.sources ?? []).map((s) => (typeof s === "string" ? s : s.name)),
    ["sales"],
  );

  // The whole payload landed: model files (incl. the dashboard's .malloy and
  // malloy-config.json) and the dashboard artifact.
  const files = await db
    .select({ path: malloyModelFiles.path })
    .from(malloyModelFiles)
    .where(eq(malloyModelFiles.modelId, model.id));
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["dashboards/totals.malloy", "index.malloy", "malloy-config.json"]);

  const arts = await db
    .select({ name: malloyArtifacts.name, title: malloyArtifacts.title })
    .from(malloyArtifacts)
    .where(eq(malloyArtifacts.modelId, model.id));
  assert.deepEqual(arts, [{ name: "totals", title: "Totals" }]);
});

test("--create-dataset on an existing dataset publishes a new version instead of a second dataset", async () => {
  const dir = makeProject(DS_MAIN);
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /created dataset/);
  assert.match(r.stdout, /published version 2/);

  const rows = await datasetRows(DS_MAIN);
  assert.equal(rows.length, 1, "the flag must be idempotent — no duplicate dataset");
  assert.equal((await models(rows[0].id)).length, 2);
});

test("a plain publish keeps working against the dataset the flag created", async () => {
  const dir = makeProject(DS_MAIN);
  const r = await runCli(["publish", "test", dir, "--token", token], dir);

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /published version 3/);

  const status = await runCli(["status", "test", "--token", token], dir);
  assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
  assert.match(status.stdout, new RegExp(`dataset=${DS_MAIN}`));
  assert.match(status.stdout, /version 3/);
  assert.match(status.stdout, /✓ compiled/);
});

test("--create-dataset on a model that doesn't compile leaves no dataset behind", async () => {
  const dir = makeProject(`broken_ds_${RUN}`, { model: BROKEN });
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  assert.equal(
    (await datasetRows(`broken_ds_${RUN}`)).length,
    0,
    "the dataset is created only after the model compiles",
  );
});

test("--create-dataset rejects a name that isn't a usable dataset slug", async () => {
  const dir = makeProject(`Pet Shop ${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, new RegExp(`cannot create dataset "Pet Shop ${RUN}"`));
  assert.match(out, new RegExp(`use "pet_shop_${RUN}"`));
  assert.equal((await datasetRows(`Pet Shop ${RUN}`)).length, 0);
  assert.equal(
    (await datasetRows(`pet_shop_${RUN}`)).length,
    0,
    "never silently create under a different name",
  );
});

test("a bad token can't create anything", async () => {
  const dir = makeProject(`unauth_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", "not-a-real-token", "--create-dataset"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /invalid or revoked token/);
  assert.equal((await datasetRows(`unauth_ds_${RUN}`)).length, 0);
});

test("a non-admin token can't create anything", async () => {
  const [plain] = await db
    .insert(users)
    .values({ email: `reader-${RUN}@test.local`, slug: `reader-${RUN}` })
    .returning();
  seededUsers.push(plain.id);
  const raw = randomBytes(32).toString("base64url");
  await db.insert(oauthAccessTokens).values({
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    clientId,
    userId: plain.id,
    scope: "mcp",
    resource: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const dir = makeProject(`nonadmin_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", raw, "--create-dataset"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /admin required/);
  assert.equal((await datasetRows(`nonadmin_ds_${RUN}`)).length, 0);
});

test("--dry-run never reaches the server, even with --create-dataset", async () => {
  const dir = makeProject(`dryrun_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset", "--dry-run"], dir);

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /dry run — not sending/);
  assert.equal((await datasetRows(`dryrun_ds_${RUN}`)).length, 0);
});

test("the dataset the flag created is addressable by name and unique among ready datasets", async () => {
  const rows = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.name, DS_MAIN), eq(datasets.status, "ready")));
  assert.equal(rows.length, 1);
});
