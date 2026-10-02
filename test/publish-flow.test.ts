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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  repos,
  oauthClients,
  oauthAccessTokens,
  apiTokens,
  draftDashboards,
  type ApiTokenScope,
  type User,
} from "@/db";
import { createApiToken } from "@/lib/api-tokens";
import { latestModel } from "@/lib/mcp-tools";
import { POST as pushRoute } from "@/app/api/datasets/[id]/model/push/route";
import { GET as statusRoute } from "@/app/api/datasets/[id]/model/status/route";
import { POST as repoPushRoute } from "@/app/api/repos/push/route";
import { GET as draftListRoute, POST as draftSaveRoute } from "@/app/api/datasets/[id]/drafts/route";
import { GET as draftGetRoute, POST as draftPromoteRoute } from "@/app/api/datasets/[id]/drafts/[slug]/route";
import { GET as whoamiRoute } from "@/app/api/cli/whoami/route";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- routes differ in their params shape
type Handler = (req: Request, ctx: { params: Promise<any> }) => Promise<Response>;

/** `params` names the pattern's capture groups, so a route with a second
    segment (a draft's slug) mounts like any other. */
const ROUTES: Array<{ method: string; pattern: RegExp; handler: Handler; params?: string[] }> = [
  { method: "POST", pattern: /^\/api\/datasets\/([^/]+)\/model\/push$/, handler: pushRoute },
  { method: "GET", pattern: /^\/api\/datasets\/([^/]+)\/model\/status$/, handler: statusRoute },
  { method: "POST", pattern: /^\/api\/datasets\/([^/]+)\/drafts$/, handler: draftSaveRoute },
  { method: "GET", pattern: /^\/api\/datasets\/([^/]+)\/drafts$/, handler: draftListRoute },
  {
    method: "GET",
    pattern: /^\/api\/datasets\/([^/]+)\/drafts\/([^/]+)$/,
    handler: draftGetRoute,
    params: ["id", "slug"],
  },
  {
    method: "POST",
    pattern: /^\/api\/datasets\/([^/]+)\/drafts\/([^/]+)$/,
    handler: draftPromoteRoute,
    params: ["id", "slug"],
  },
  // The repo IS the unit of publish, so it has a route of its own: one archive,
  // every dataset in it, one transaction.
  { method: "POST", pattern: /^\/api\/repos\/push$/, handler: repoPushRoute, params: [] },
  { method: "GET", pattern: /^\/api\/cli\/(whoami)$/, handler: whoamiRoute },
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
        const m = route.pattern.exec(url.pathname)!;
        const names = route.params ?? ["id"];
        const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
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
        const response = await route.handler(request, { params: Promise.resolve(params) });
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

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  /** Written to the CLI's stdin, then closed (e.g. a token for --token-stdin). */
  input?: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        // MALLOYYO_TOKEN is blanked unless a test sets it: the CLI reads it
        // from the ambient environment by design, and a developer who has one
        // exported would otherwise change what these tests exercise. Empty
        // reads as unset (see tokenSource).
        env: { ...process.env, NO_COLOR: "1", MALLOYYO_TOKEN: "", ...env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
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
function makeProject(
  dataset: string,
  opts: {
    model?: string;
    dashboard?: boolean;
    tokenEnv?: string;
    /** Write a .devcontainer/devcontainer.json, as `malloyyo init` does. */
    devcontainer?: boolean;
    /** Extra `connections` entries, e.g. one whose password is an unset env ref. */
    connections?: Record<string, unknown>;
  } = {},
): string {
  // In os.tmpdir(), NOT the repo: gatherDirectory's git probe would otherwise
  // stamp this repo's commit onto the payload and make assertions drift.
  const dir = mkdtempSync(join(tmpdir(), "malloyyo-publish-"));
  projects.push(dir);
  writeFileSync(
    join(dir, "malloy-config.json"),
    JSON.stringify(
      {
        connections: { duckdb: { is: "duckdb" }, ...(opts.connections ?? {}) },
        malloyyo: {
          targets: {
            test: {
              url: serverUrl,
              dataset,
              ...(opts.tokenEnv ? { malloyyo_token: { env: opts.tokenEnv } } : {}),
            },
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "index.malloy"), opts.model ?? MODEL);
  if (opts.devcontainer) {
    mkdirSync(join(dir, ".devcontainer"));
    writeFileSync(
      join(dir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ image: "ghcr.io/malloydata/malloyyo-devcontainer" }),
    );
  }
  if (opts.dashboard) {
    mkdirSync(join(dir, "dashboards"));
    writeFileSync(join(dir, "dashboards", "totals.malloy"), DASHBOARD);
  }
  return dir;
}

async function datasetRows(name: string) {
  return db.select().from(datasets).where(eq(datasets.name, name));
}

/** An ordinary admitted user — no admin role, which is the point. */
async function seedMember(email: string): Promise<User> {
  const [u] = await db.insert(users).values({ email, status: "active", role: "member" }).returning();
  seededUsers.push(u.id);
  return u;
}

/** A live dataset owned by someone. Inserted directly: creating one through the
    app is an admin act, and these tests are about publishing to an existing one. */
async function seedDataset(name: string, userId: string) {
  const [ds] = await db
    .insert(datasets)
    .values({ name, userId, isPublic: false, status: "ready", readyAt: new Date() })
    .returning();
  return ds;
}

/** An OAuth access token like the one a browser sign-in produces. `scope` is
    what the client asked for: "mcp publish" is `malloyyo login`, plain "mcp" is
    a claude.ai connection (and every grant issued before publishing had a scope
    of its own). */
async function seedOAuthToken(userId: string, scope: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(oauthAccessTokens).values({
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    clientId,
    userId,
    scope,
    resource: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return raw;
}

/** Mint through the real code path, so the format and hashing are exercised. */
async function mintFor(userId: string, scopes: ApiTokenScope[]): Promise<string> {
  const created = await createApiToken({ userId, name: `test-${RUN}`, scopes, expiresAt: null });
  assert.ok(created.ok, "expected the token to be minted");
  return created.raw;
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
    .values({
      email: `publisher-${RUN}@test.local`,
      status: "active",
      role: "admin",
      isAdmin: true,
    })
    .returning();
  admin = u;
  seededUsers.push(u.id);

  // A real bearer token, minted the way the OAuth route mints one: the server
  // validates it against oauth_access_tokens, so auth is exercised for real.
  // Scope "mcp publish" is what `malloyyo login` requests.
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
    scope: "mcp publish",
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

test("a publish ACTIVATES what it wrote — or the instance serves the previous version forever", async () => {
  // THE WORST BUG IN THE REWRITE, caught in review.
  //
  // The model a dataset serves is now STATED (`malloy_models.active`) rather
  // than derived from `order by created_at desc limit 1`, which ties. This route
  // was not setting it, and `latestModel` only falls back to the newest row when
  // NO row is active — so any dataset with an active row kept serving it while
  // every push here reported a new version number. Silent, permanent, and worse
  // with every publish.
  //
  // And a dataset with an active row is not a corner case: 0026 set one for
  // every dataset that existed at migration time. That is why this test seeds
  // one explicitly instead of relying on a push to create it — a test that
  // published twice through this route would have found both rows inactive and
  // the `version desc` fallback would have returned the right answer.
  const name = `pf_active_${RUN}`;
  const ds = await seedDataset(name, admin.id);
  const [old] = await db
    .insert(malloyModels)
    .values({
      datasetId: ds.id,
      version: 1,
      source: "source: stale is 1",
      generatedBy: "pretend-this-was-migrated",
      active: true,
    })
    .returning();

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir, "--token", token], dir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /published version 2/);

  const rows = await models(ds.id);
  assert.equal(rows.length, 2);
  const active = rows.filter((m) => m.active);
  assert.equal(active.length, 1, "exactly one active model");
  assert.equal(active[0].version, 2, "and it is the one just published");
  assert.notEqual(active[0].id, old.id);
  // Through the seam every read path uses, not just the column.
  const served = await latestModel(ds.id);
  assert.equal(served.id, active[0].id, "…which is what the instance serves");
  assert.match(served.source, /Pet shop sales/);
});

test("…and a dataset created by that route is servable at once", async () => {
  // The same bug in its second shape: `/api/sources` requires `active = true`
  // with no fallback, so a dataset created entirely after the migration by
  // `--dataset x` would have appeared in the catalogue with NO SOURCES.
  const name = `pf_active_new_${RUN}`;
  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  const [ds] = await datasetRows(name);
  const rows = await models(ds.id);
  assert.equal(rows.filter((m) => m.active).length, 1, "its first model is active");
  assert.ok((await latestModel(ds.id)).sources, "and carries the sources the catalogue reads");
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

test("a model whose config needs an unset secret says WHICH secret, not just the connect error", async () => {
  // Port 1 so the connect fails instantly and identically everywhere — the point
  // of the test is the env-var diagnosis, not the socket error.
  const dir = makeProject(`secret_ds_${RUN}`, {
    model: `source: needs_secret is pg.sql("select 1 as one")\n`,
    connections: {
      pg: {
        is: "postgres",
        host: "127.0.0.1",
        port: 1,
        database: "nope",
        user: "nope",
        password: { env: "MALLOYYO_TEST_SECRET_UNSET" },
      },
    },
  });
  // Malloy resolves an unset {env:…} to empty and fails at CONNECT time, so the
  // raw error never mentions the secret. Both ends check for it explicitly.
  // Locally first — the CLI lints before it sends, and that's where a developer
  // meets the error.
  const local = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);
  assert.notEqual(local.code, 0, `expected a non-zero exit\n${local.stdout}\n${local.stderr}`);
  const localOut = local.stdout + local.stderr;
  assert.match(localOut, /\$MALLOYYO_TEST_SECRET_UNSET/);
  assert.match(localOut, /NOT set on this shell/);

  // …and again from the server, for the case where the secret is set locally but
  // not on the deployment (--skip-lint stands in for "it compiled here").
  const remote = await runCli(
    ["publish", "test", dir, "--token", token, "--create-dataset", "--skip-lint"],
    dir,
  );
  assert.notEqual(remote.code, 0, `expected a non-zero exit\n${remote.stdout}\n${remote.stderr}`);
  const remoteOut = remote.stdout + remote.stderr;
  assert.match(remoteOut, /\$MALLOYYO_TEST_SECRET_UNSET/);
  assert.match(remoteOut, /NOT set on http/);
  assert.match(remoteOut, /Secrets don't travel with the model/);

  assert.equal((await datasetRows(`secret_ds_${RUN}`)).length, 0);
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

test("a bad token can't create anything, and the error says how to fix it", async () => {
  const dir = makeProject(`unauth_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", "not-a-real-token", "--create-dataset"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /invalid or revoked token/);
  // The target resolved fine — it's the credential that's wrong, so say so and
  // name the command that fixes it.
  assert.match(out, /came from --token/);
  assert.match(out, /malloyyo login test/);
  assert.equal((await datasetRows(`unauth_ds_${RUN}`)).length, 0);
});

test("a bad token from the config's env var names that var, and still points at login", async () => {
  const dir = makeProject(`envtoken_ds_${RUN}`, { tokenEnv: "MALLOYYO_TEST_TOKEN" });
  const r = await runCli(["publish", "test", dir, "--create-dataset"], dir, {
    MALLOYYO_TEST_TOKEN: "not-a-real-token",
  });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /invalid or revoked token/);
  assert.match(out, /\$MALLOYYO_TEST_TOKEN/);
  assert.match(out, /malloyyo login test/);
  assert.equal((await datasetRows(`envtoken_ds_${RUN}`)).length, 0);
});

test("status reports the server's auth error, not a bare 401", async () => {
  const dir = makeProject(DS_MAIN);
  const r = await runCli(["status", "test", "--token", "not-a-real-token"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /invalid or revoked token/);
  assert.match(out, /malloyyo login test/);
});

test("a non-admin token can't create a dataset", async () => {
  // Creating one is admin-only in the UI (POST /api/datasets), so a member's
  // token must not be a way around that gate — only a way to publish to the
  // datasets they already own (the test below).
  const member = await seedMember(`reader-${RUN}@test.local`);
  const raw = await seedOAuthToken(member.id, "mcp publish");

  const dir = makeProject(`nonadmin_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir, "--token", raw, "--create-dataset"], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /creating one is admin-only/);
  // A 403 is a different problem from a 401 — logging in again won't help.
  assert.match(out, /isn't allowed to do this/);
  assert.doesNotMatch(out, /malloyyo login/);
  assert.equal((await datasetRows(`nonadmin_ds_${RUN}`)).length, 0);
});

test("an MCP-only OAuth grant cannot publish, however privileged its owner", async () => {
  // The claude.ai case: a token delegated to a third party for QUERYING must
  // not also be able to overwrite a model. The owner here is the admin, so
  // nothing but the scope is standing in the way.
  const name = `mcpgrant_ds_${RUN}`;
  const ds = await seedDataset(name, admin.id);
  const raw = await seedOAuthToken(admin.id, "mcp");

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir, "--token", raw], dir);

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /does not carry the "publish" scope/);
  assert.equal((await models(ds.id)).length, 0);
});

test("a login stored before publish scopes existed is told to sign in again", async () => {
  // The upgrade path, and the one case where the fix really is `login`: the
  // credentials file holds a grant from an older vintage.
  const name = `oldlogin_ds_${RUN}`;
  await seedDataset(name, admin.id);
  const raw = await seedOAuthToken(admin.id, "mcp");

  const configHome = mkdtempSync(join(tmpdir(), "malloyyo-creds-"));
  projects.push(configHome);
  mkdirSync(join(configHome, "malloyyo"));
  writeFileSync(
    join(configHome, "malloyyo", "credentials.json"),
    JSON.stringify({
      [serverUrl]: {
        clientId,
        accessToken: raw,
        refreshToken: "not-used-here",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    }),
  );

  const dir = makeProject(name);
  // No --token and no env var: this is the stored-login branch of the precedence.
  const r = await runCli(["publish", "test", dir], dir, { XDG_CONFIG_HOME: configHome });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /does not carry the "publish" scope/);
  assert.match(out, /carries only "mcp"/);
  assert.match(out, /malloyyo login test/);
});

// ── minted API tokens (the MALLOYYO_TOKEN path) ──────────────────────────────

test("a minted API token publishes, and $MALLOYYO_TOKEN is enough on its own", async () => {
  // The whole point of the feature: no --token, no stored login, no browser.
  const owner = await seedMember(`owner-${RUN}@test.local`);
  const name = `owned_ds_${RUN}`;
  await seedDataset(name, owner.id);
  const minted = await mintFor(owner.id, ["publish"]);

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir], dir, { MALLOYYO_TOKEN: minted });

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /published version 1/);

  const status = await runCli(["status", "test"], dir, { MALLOYYO_TOKEN: minted });
  assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
  assert.match(status.stdout, /version 1/);

  // Using it stamps last_used_at, which is how a forgotten token is spotted.
  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.userId, owner.id));
  assert.ok(row.lastUsedAt, "expected the token's last_used_at to be recorded");
});

test("a token without the publish scope is refused, and told which scope it lacks", async () => {
  const owner = await seedMember(`mcponly-${RUN}@test.local`);
  const name = `mcponly_ds_${RUN}`;
  const ds = await seedDataset(name, owner.id);
  const minted = await mintFor(owner.id, ["mcp"]);

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir], dir, { MALLOYYO_TOKEN: minted });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /does not carry the "publish" scope/);
  // The advice must point at the token page, not at `login` — the credential is
  // fine, it just wasn't given this permission.
  assert.match(out, /settings\/tokens/);
  assert.equal((await models(ds.id)).length, 0);
});

test("a token can't publish to someone else's dataset", async () => {
  const [outsider, name] = [await seedMember(`outsider-${RUN}@test.local`), `others_ds_${RUN}`];
  const stranger = await seedMember(`stranger-${RUN}@test.local`);
  const ds = await seedDataset(name, stranger.id);
  const minted = await mintFor(outsider.id, ["publish"]);

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir], dir, { MALLOYYO_TOKEN: minted });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /doesn't own dataset/);
  assert.equal((await models(ds.id)).length, 0, "nothing is written for a refused publish");
});

test("an admin's token publishes to a dataset owned by someone else", async () => {
  // Admins keep the authority they had when publishing was admin-only.
  const stranger = await seedMember(`admin-target-${RUN}@test.local`);
  const name = `adminpub_ds_${RUN}`;
  await seedDataset(name, stranger.id);
  const minted = await mintFor(admin.id, ["publish"]);

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir], dir, { MALLOYYO_TOKEN: minted });

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /published version 1/);
});

test("a revoked token stops working immediately", async () => {
  const owner = await seedMember(`revoked-${RUN}@test.local`);
  const name = `revoked_ds_${RUN}`;
  const ds = await seedDataset(name, owner.id);
  const minted = await mintFor(owner.id, ["publish"]);
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(eq(apiTokens.userId, owner.id));

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir], dir, { MALLOYYO_TOKEN: minted });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /invalid or revoked token/);
  // 401 advice names the variable it actually read — otherwise "invalid token"
  // sends someone to re-run `login`, which wouldn't be used.
  assert.match(out, /\$MALLOYYO_TOKEN/);
  assert.equal((await models(ds.id)).length, 0);
});

test("a token minted on another instance says so instead of just failing", async () => {
  const owner = await seedMember(`elsewhere-${RUN}@test.local`);
  const name = `elsewhere_ds_${RUN}`;
  await seedDataset(name, owner.id);

  const dir = makeProject(name);
  const r = await runCli(["publish", "test", dir], dir, {
    MALLOYYO_TOKEN: `myo_somewhereelse_${randomBytes(32).toString("base64url")}`,
  });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /minted on "somewhereelse"/);
});

test("a value that isn't a token at all is diagnosed as the wrong secret", async () => {
  // The MotherDuck-rename hazard: MALLOYYO_TOKEN used to hold a warehouse
  // secret in some configs, and a bare 401 points nowhere near that.
  const dir = makeProject(`wrongsecret_ds_${RUN}`);
  const r = await runCli(["publish", "test", dir], dir, {
    MALLOYYO_TOKEN: "eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uIjoiYWJjIn0.sig",
  });

  assert.notEqual(r.code, 0, `expected a non-zero exit\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /isn't shaped like a Malloyyo token/);
  assert.match(out, /warehouse password/);
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

// The repo's dev container travels with the model, so the app can tell whether
// this dataset opens as a working codespace without asking GitHub per page view.
// Worth an end-to-end test rather than a unit one: gatherDirectory skips every
// dotted entry, so this file reaches the server only by a deliberate exception
// — and nothing downstream would fail loudly if that exception regressed. The
// icon would just quietly stop working.
test("a repo's dev container is published with the model", async () => {
  const ds = `${DS_MAIN}_devcontainer`;
  const dir = makeProject(ds, { devcontainer: true });
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  const [row] = await datasetRows(ds);
  const [model] = await models(row.id);
  const files = await db
    .select({ path: malloyModelFiles.path, content: malloyModelFiles.content })
    .from(malloyModelFiles)
    .where(eq(malloyModelFiles.modelId, model.id));

  const found = files.find((f) => f.path === ".devcontainer/devcontainer.json");
  assert.ok(found, `devcontainer.json published — got ${files.map((f) => f.path).join(", ")}`);
  assert.match(found.content, /malloyyo-devcontainer/);
});

test("a repo without a dev container publishes without one", async () => {
  const ds = `${DS_MAIN}_nodevcontainer`;
  const dir = makeProject(ds);
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  const [row] = await datasetRows(ds);
  const [model] = await models(row.id);
  const files = await db
    .select({ path: malloyModelFiles.path })
    .from(malloyModelFiles)
    .where(eq(malloyModelFiles.modelId, model.id));
  assert.equal(files.some((f) => f.path === ".devcontainer/devcontainer.json"), false);
  // And the model itself still published, so this is not a vacuous pass.
  assert.ok(files.some((f) => f.path === "index.malloy"));
});

// ── draft dashboards: login --token-stdin, draft list, draft promote ─────────

const DS_DRAFT = `petshop_draft_${RUN}`;

/** What a draft made from a chat client looks like: one component, queries
    inline. Promotion has to turn that into a repo dashboard. */
const DRAFT_COMPONENT = `import { useQuery } from "@malloyyo/dashboard";
export default function D() {
  const q = useQuery({ malloy: \`run: sales -> { group_by: state; aggregate: total_qty }\` });
  return <ol>{(q.rows ?? []).map((r) => <li key={String(r.state)}>{String(r.state)}</li>)}</ol>;
}
`;

/** A published dataset, a checkout to promote into, and an isolated credential
    store (so a developer's real ~/.config/malloyyo is never read). */
async function draftProject(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = makeProject(DS_DRAFT);
  const published = await runCli(["publish", "--create-dataset", "--token", token], dir);
  assert.equal(published.code, 0, published.stderr);
  const xdg = mkdtempSync(join(tmpdir(), "malloyyo-xdg-"));
  projects.push(xdg);
  return { dir, env: { XDG_CONFIG_HOME: xdg } };
}

let draftCtx: { dir: string; env: Record<string, string> } | undefined;
async function draftFixture() {
  return (draftCtx ??= await draftProject());
}

/** Drafts are made on the instance, never pushed from a checkout — so the
    tests make them the way a chat client does. */
async function makeDraft(body: Record<string, unknown>): Promise<{ slug: string; dashboard: string }> {
  const res = await fetch(`${serverUrl}/api/datasets/${DS_DRAFT}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json()) as { ok: boolean; error?: string; slug: string; dashboard: string };
  assert.equal(out.ok, true, out.error);
  return out;
}

test("login --token-stdin stores a token only after the instance accepts it", async () => {
  const { dir, env } = await draftFixture();
  const mcpToken = await mintFor(admin.id, ["mcp"]);

  const bogus = await runCli(["login", serverUrl, "--token-stdin"], dir, env, "myo_x_not-a-real-token");
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.stderr, /did not accept that token/);

  const ok = await runCli(["login", serverUrl, "--token-stdin"], dir, env, `${mcpToken}\n`);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`logged in to ${serverUrl.replace(/[.]/g, "\\.")} as publisher-${RUN}@test\\.local`));
  const stored = JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME, "malloyyo", "credentials.json"), "utf8"));
  assert.equal(stored[serverUrl].accessToken, mcpToken);
  assert.equal(stored[serverUrl].refreshToken, undefined, "a pasted token has nothing to refresh with");
});

test("draft list shows what is on the instance, with the slug promotion takes", async () => {
  const { dir, env } = await draftFixture();
  const { slug } = await makeDraft({ name: "by_state", title: "By state", source: DRAFT_COMPONENT });
  const r = await runCli(["draft", "list", ".", "--token", token], dir, env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${slug}\\s+By state\\s+\\(component,`));
});

test("draft promote writes the repo files, records what it became, and keeps the draft", async () => {
  const { dir, env } = await draftFixture();
  const { slug, dashboard } = await makeDraft({ name: "by_state", title: "By state", source: DRAFT_COMPONENT });

  const r = await runCli(["draft", "promote", slug, ".", "--name", "states", "--token", token], dir, env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /promoted 'By state'/);

  // The component lands as-is; the .malloy is a scaffold carrying the inline
  // queries, because a repo dashboard's queries live in the model.
  const component = readFileSync(join(dir, "dashboards", "states.jsx"), "utf8");
  assert.match(component, /useQuery/);
  const malloy = readFileSync(join(dir, "dashboards", "states.malloy"), "utf8");
  assert.match(malloy, /import "\.\.\/index\.malloy"/);
  assert.match(malloy, /# artifact \{ title="By state" \}/);
  assert.match(malloy, /run: sales -> \{ group_by: state; aggregate: total_qty \}/, "the inline query, to lift");
  assert.match(r.stdout, /lift 1 inline query/);

  // Recorded, not deleted: people hold the draft's URL.
  const [row] = await db.select().from(draftDashboards).where(eq(draftDashboards.slug, slug));
  assert.equal(row?.promotedAs, "states");
  assert.ok(row?.promotedHash && row.promotedAt, "hash + timestamp recorded");
  assert.match(r.stdout, new RegExp(`the draft stays live .*${dashboard}`));
});

test("draft promote carries a two-file draft's .malloy through unchanged", async () => {
  const { dir, env } = await draftFixture();
  const malloySource = `import "../index.malloy"\n# artifact { title="Animals" }\nquery: animals is sales -> { group_by: animal; aggregate: total_qty }\n`;
  const { slug } = await makeDraft({ name: "animals", malloy: malloySource });

  const r = await runCli(["draft", "promote", slug, ".", "--token", token], dir, env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(dir, "dashboards", "animals.malloy"), "utf8").trim(), malloySource.trim());
  assert.doesNotMatch(r.stdout, /lift/, "nothing to lift — its queries are already in the model file");
});

test("draft promote won't quietly overwrite a dashboard that already exists", async () => {
  const { dir, env } = await draftFixture();
  const { slug } = await makeDraft({ name: "by_state", title: "By state", source: DRAFT_COMPONENT });
  await runCli(["draft", "promote", slug, ".", "--name", "collide", "--token", token], dir, env);
  const before = readFileSync(join(dir, "dashboards", "collide.jsx"), "utf8");

  const second = await runCli(["draft", "promote", slug, ".", "--name", "collide", "--token", token], dir, env);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already exist/);
  assert.equal(readFileSync(join(dir, "dashboards", "collide.jsx"), "utf8"), before);

  const forced = await runCli(["draft", "promote", slug, ".", "--name", "collide", "--force", "--token", token], dir, env);
  assert.equal(forced.code, 0, forced.stderr);
});

test("a draft's own files are refused when they reach past the model", async () => {
  const before = (await db.select().from(draftDashboards)).length;
  const res = await fetch(`${serverUrl}/api/datasets/${DS_DRAFT}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: "leak",
      malloy: `import "../index.malloy"\n# artifact { title="x" }\nquery: q is duckdb.sql("select 1 as x") -> { select: x }\n`,
    }),
  });
  const out = (await res.json()) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /restricted check/);
  assert.equal((await db.select().from(draftDashboards)).length, before, "nothing stored");
});

test("a draft can only be overwritten by the person who made it", async () => {
  const { slug } = await makeDraft({ name: "by_state", title: "By state", source: DRAFT_COMPONENT });

  // Someone who can see the dataset (it's public) but didn't make the draft.
  await db.update(datasets).set({ isPublic: true }).where(eq(datasets.name, DS_DRAFT));
  const other = await seedMember(`other-${RUN}@test.local`);
  const res = await fetch(`${serverUrl}/api/datasets/${DS_DRAFT}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await mintFor(other.id, ["mcp"])}` },
    body: JSON.stringify({ name: "by_state", source: DRAFT_COMPONENT, slug }),
  });
  const out = (await res.json()) as { ok: boolean; error?: string };
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /belongs to someone else/);
});

test("draft promote validates --name instead of writing outside dashboards/", async () => {
  const { dir, env } = await draftFixture();
  const { slug } = await makeDraft({ name: "by_state", title: "By state", source: DRAFT_COMPONENT });
  const r = await runCli(["draft", "promote", slug, ".", "--name", "../escape", "--token", token], dir, env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--name must be letters, digits/);
  assert.equal(existsSync(join(dir, "..", "escape.malloy")), false, "nothing written outside the checkout");
});

test("a draft is recorded by its own author; a colleague gets the files and a note", async () => {
  const { dir, env } = await draftFixture();
  const { slug } = await makeDraft({ name: "by_state", title: "By state", source: DRAFT_COMPONENT });
  await db.update(datasets).set({ isPublic: true }).where(eq(datasets.name, DS_DRAFT));
  const colleague = await seedMember(`promoter-${RUN}@test.local`);
  const theirToken = await mintFor(colleague.id, ["mcp"]);

  const r = await runCli(["draft", "promote", slug, ".", "--name", "theirs", "--token", theirToken], dir, env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(dir, "dashboards", "theirs.jsx")), "the files are still written");
  assert.match(r.stdout, /not recorded on the draft/);
  const [row] = await db.select().from(draftDashboards).where(eq(draftDashboards.slug, slug));
  assert.equal(row?.promotedAs, null, "the author's row is untouched");
});

// ── Tenant scoping: the dataset is the authority ────────────────────────────
//
// What a dataset is scoped by is CONFIGURED by an admin, and a model published
// to it must declare those givens. The exception is creation, which has no admin
// to have configured anything. See docs/multi-tenant-givens.md.

const SCOPED_MODEL = `##! experimental { givens }
given:
  MALLOYYO_EMAIL :: string is ''
#" Pet shop sales, scoped to the buyer.
source: sales is duckdb.sql("""
  SELECT 'dog' as animal, 'a@b.com' as buyer, 2 as qty
  UNION ALL SELECT 'cat', 'c@d.com', 3
""") extend {
  where: buyer = $MALLOYYO_EMAIL
  measure: total_qty is qty.sum()
  #" Units sold per animal.
  view: by_animal is { group_by: animal; aggregate: total_qty }
}
`;

test("a dataset created by a publish takes its scoping from that model", async () => {
  const name = `${DS_MAIN}_scoped`;
  const dir = makeProject(name, { model: SCOPED_MODEL });
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  const [ds] = await datasetRows(name);
  assert.deepEqual(ds.requiredGivens, ["MALLOYYO_EMAIL"], "no admin had a chance to configure it");
});

test("a model that stops declaring what the dataset is scoped by is REFUSED", async () => {
  const name = `${DS_MAIN}_sticky`;
  const scoped = makeProject(name, { model: SCOPED_MODEL });
  assert.equal(
    (await runCli(["publish", "test", scoped, "--token", token, "--create-dataset"], scoped)).code,
    0,
  );

  // The accident: the given and its filter are gone. Publishing this would
  // return every buyer's rows to every user.
  const plain = makeProject(name, { model: MODEL });
  const r = await runCli(["publish", "test", plain, "--token", token], plain);

  assert.notEqual(r.code, 0, "the publish must fail");
  assert.match(`${r.stdout}${r.stderr}`, /does not declare it/);

  const [ds] = await datasetRows(name);
  assert.deepEqual(ds.requiredGivens, ["MALLOYYO_EMAIL"], "and the requirement survives");
  assert.equal((await models(ds.id)).length, 1, "no second version was written");
});

test("publishing does not add to what a dataset is scoped by", async () => {
  // Configured, not derived: a model declaring MORE than the dataset requires
  // publishes fine and changes nothing, but says so — nothing supplies the
  // extra one, so its filter would quietly use the declaration default.
  const name = `${DS_MAIN}_extra`;
  const plain = makeProject(name, { model: MODEL });
  assert.equal(
    (await runCli(["publish", "test", plain, "--token", token, "--create-dataset"], plain)).code,
    0,
  );
  assert.deepEqual((await datasetRows(name))[0].requiredGivens, [], "created unscoped");

  const scoped = makeProject(name, { model: SCOPED_MODEL });
  const r = await runCli(["publish", "test", scoped, "--token", token], scoped);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /declares MALLOYYO_EMAIL, which this dataset is NOT scoped by/);
  assert.deepEqual((await datasetRows(name))[0].requiredGivens, [], "still unscoped");
});

test("a reserved given this server does not fill is refused at publish", async () => {
  const name = `${DS_MAIN}_reserved`;
  const dir = makeProject(name, {
    model: SCOPED_MODEL.replace("MALLOYYO_EMAIL :: string is ''", "MALLOYYO_ROLE :: string is ''")
      .replace("buyer = $MALLOYYO_EMAIL", "buyer = $MALLOYYO_ROLE"),
  });
  const r = await runCli(["publish", "test", dir, "--token", token, "--create-dataset"], dir);

  assert.notEqual(r.code, 0);
  assert.match(`${r.stdout}${r.stderr}`, /reserved/);
  assert.equal((await datasetRows(name)).length, 0, "a refused publish creates no dataset");
});

// ── The repo is the unit of publish ─────────────────────────────────────────
//
// `malloyyo publish --repo` packs the whole repo and sends it as one archive —
// the same shape GitHub hands the server for a repo it pulls — and every dataset
// in it lands together or none does.

const REPO_SLUG = `lloydtabb/repo_flow_${RUN}`;

/** A repo with a `datasets/` directory: one directory per dataset. */
function makeRepo(names: string[], opts: { broken?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "malloyyo-repo-"));
  projects.push(dir);
  writeFileSync(
    join(dir, "malloy-config.json"),
    JSON.stringify(
      { connections: { duckdb: { is: "duckdb" } }, malloyyo: { targets: { test: { url: serverUrl } } } },
      null,
      2,
    ),
  );
  for (const name of names) {
    const d = join(dir, "datasets", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "index.malloy"),
      name === opts.broken ? "source: oops is no_such_source extend { }" : MODEL,
    );
  }
  return dir;
}

test("a repo publishes every dataset it holds, in one request", async () => {
  const names = [`rf_a_${RUN}`, `rf_b_${RUN}`];
  const dir = makeRepo(names);
  const r = await runCli(
    ["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--create-datasets", "--token", token],
    dir,
  );
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  for (const name of names) {
    const [ds] = await datasetRows(name);
    assert.ok(ds, `${name} was created`);
    // Membership is a FOREIGN KEY now, not a text match on two columns anyone
    // could edit a row at a time.
    assert.ok(ds.repoId, "…and belongs to a repo row");
    assert.equal(ds.repoDir, `datasets/${name}`, "…at its own directory");
    // A CLI publish does NOT make the repo GitHub-refreshable. One pair of
    // columns used to mean both "these belong together" and "GitHub backs
    // this", so this path stamped the author's local branch and the refresh
    // button would pull over the top of what had just been pushed.
    const [repoRow] = await db.select().from(repos).where(eq(repos.id, ds.repoId!));
    assert.equal(repoRow.githubRepo, null, "…and the repo is not attached to GitHub");
    assert.equal((await models(ds.id)).length, 1);
  }
});

test("a repo with a broken dataset publishes NOTHING", async () => {
  // The property atomicity exists for. The datasets that would have landed look
  // healthy, and the one that did not is the one nobody checks.
  const names = [`rf_c_${RUN}`, `rf_d_${RUN}`];
  const good = makeRepo(names);
  assert.equal(
    (await runCli(
      ["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--create-datasets", "--token", token],
      good,
    )).code,
    0,
  );
  const before = await Promise.all(names.map(async (n) => (await models((await datasetRows(n))[0].id)).length));

  const broken = makeRepo(names, { broken: names[1] });
  const r = await runCli(
    ["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--token", token, "--skip-lint"],
    broken,
  );
  assert.notEqual(r.code, 0, "the publish must fail");

  const after = await Promise.all(names.map(async (n) => (await models((await datasetRows(n))[0].id)).length));
  assert.deepEqual(after, before, "no dataset gained a version — not even the one that compiled");
});

test("a repo that fails to compile while CREATING leaves no rows, and no name taken", async () => {
  // The creation path's half of all-or-nothing.
  //
  // This test passes against the shape that had the bug, and that is the point
  // worth writing down: the old code inserted the rows, compiled, and deleted
  // them when the compile failed, which is indistinguishable from here because
  // this process stays alive to run the delete. What it could not survive was a
  // timeout or a redeploy mid-compile, leaving a `ready` row with no model
  // holding its name under `datasets_name_ready_unique` forever. That window is
  // not reachable from a test; src/lib/repos-push-atomic.test.ts pins the
  // mechanism that closes it. This one pins the contract that mechanism serves.
  const names = [`rf_x_${RUN}`, `rf_y_${RUN}`];
  const broken = makeRepo(names, { broken: names[1] });
  const bad = await runCli(
    ["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--create-datasets", "--token", token, "--skip-lint"],
    broken,
  );
  assert.notEqual(bad.code, 0, "the publish must fail");

  for (const name of names) {
    assert.equal((await datasetRows(name)).length, 0, `${name} was not created`);
  }

  // And the names are still free — the symptom the old shape produced was a 409
  // here, permanently, with nothing on the instance able to release it.
  const good = makeRepo(names);
  const ok = await runCli(
    ["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--create-datasets", "--token", token],
    good,
  );
  assert.equal(ok.code, 0, `the same names publish cleanly afterwards:\n${ok.stdout}\n${ok.stderr}`);
  for (const name of names) {
    const [ds] = await datasetRows(name);
    assert.ok(ds, `${name} exists now`);
    assert.equal((await models(ds.id)).length, 1, "…with the model it was created with");
  }
});

test("a dataset the instance does not have is refused until --create-datasets", async () => {
  const dir = makeRepo([`rf_e_${RUN}`]);
  const r = await runCli(["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--token", token], dir);
  assert.notEqual(r.code, 0);
  assert.match(`${r.stdout}${r.stderr}`, /not on this instance yet/);
  assert.equal((await datasetRows(`rf_e_${RUN}`)).length, 0, "and nothing was created");
});

test("--dataset and --repo each refuse the layout they cannot address", async () => {
  // Backward compatibility is the requirement: --dataset still means one dataset,
  // and says so plainly when the repo holds several.
  const multi = makeRepo([`rf_f_${RUN}`, `rf_g_${RUN}`]);
  const a = await runCli(["publish", "-i", serverUrl, "--dataset", "whatever", "--token", token], multi);
  assert.notEqual(a.code, 0);
  assert.match(`${a.stdout}${a.stderr}`, /--dataset cannot say which/);

  const single = makeProject(`rf_h_${RUN}`);
  const b = await runCli(["publish", "-i", serverUrl, "--repo", REPO_SLUG, "--token", token], single);
  assert.notEqual(b.code, 0);
  assert.match(`${b.stdout}${b.stderr}`, /--repo has nothing to name/);
});
