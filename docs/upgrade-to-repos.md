# Upgrading to repos — what instance admins need to know

For anyone already running a Malloyyo instance. Read the two **Act before you
upgrade** items; the rest you can read after.

---

## What changes

A repo becomes a real thing.

Until now, "repo" was not something the server stored. It was whatever set of
datasets happened to share a GitHub URL and branch — recomputed every time, from
two columns any admin could edit on any dataset independently. That is why
settings that belong to a repo (its branch, whether to use a token) were asked
for once per dataset and could disagree with each other, and why a dataset's name
had to be unique across your whole instance.

Now there is a `repos` row. Datasets belong to it. Everything that is true of the
repo is stored once, on the repo.

Two things follow that you will notice immediately:

**Datasets are named `repo:dataset`.** Your `ecommerce` dataset in the
`malloyyo_examples` repo becomes `malloyyo_examples:ecommerce`. Two repos can now
both publish a `sales` — before, the second one was refused.

**Every publish is a revision, and a revision is verified before it goes live.**
A publish stores the repo's contents, compiles every dataset in it, and only then
becomes the one being served. If any dataset fails to compile, nothing changes
and the previous revision keeps serving. You can no longer end up with three of
four datasets updated.

---

## What happens automatically

The migration runs with your deploy. You do not run anything.

It is **additive** — it creates the new tables and changes no existing data in
place. The old `datasets.github_repo`, `github_branch` and `github_use_token`
columns are still there after the upgrade, unread. They are dropped in a later
release, deliberately: on Vercel the database migrates *before* the new code is
promoted, so dropping a column the still-running version selects would take the
instance down for the length of the deploy.

The backfill groups your datasets into repos and resolves, for each repo, the
facts that used to be stored per dataset:

| Fact | How it is decided |
|---|---|
| **Repo handle** | The repo's own name, slugified — `lloydtabb/the-look` becomes `the_look`. If two owners have repos with the same name, the second gets `_2`. |
| **Owner** | The owner of the oldest dataset in the repo that is actually live. |
| **Use token** | Yes if *any* dataset in the repo said yes. A token sent needlessly is ignored; a token not sent to a private repo is a 404 and a dead dataset. |

**Old names keep working.** Every dataset name that exists today is recorded as
an alias, so saved links, shared query URLs and MCP client configurations resolve
exactly as before. The resolution order is: a UUID, then `repo:dataset`, then an
alias, then an unambiguous bare name — and if a bare name is ambiguous it is
**refused by name** rather than guessed at.

---

## Act before you upgrade

### 1. Check who owns what, if your repos have mixed owners

This is the one that can lock someone out.

Publishing used to be gated per dataset: you could publish to a dataset you
owned. It is now gated per repo. If a repo's datasets had **different owners**,
the migration picks one — the oldest live dataset's owner — and the others lose
the ability to publish to that repo.

Admins are unaffected. A non-admin who loses it has **no way to get it back
through the UI** in this release; it takes a SQL update to `repos.owner_id`.

To see whether this affects you, before upgrading:

```sql
SELECT github_repo, github_branch, count(DISTINCT user_id) AS owners
FROM datasets
WHERE github_repo IS NOT NULL
GROUP BY 1, 2
HAVING count(DISTINCT user_id) > 1;
```

Any row returned is a repo where someone will lose publish rights. Decide who
should own it and say so, rather than letting the oldest-row rule decide.

### 2. Note which repo handles you will get

The handle becomes the left half of every dataset name your users see, and
**there is no way to rename a repo in this release**. If the table above would
give you `the_look_2`, you want to know now rather than after it is baked into
every qualified name.

```sql
SELECT DISTINCT github_repo, github_branch FROM datasets WHERE github_repo IS NOT NULL;
```

---

## One change to how `--repo` publishes decide what to send

`malloyyo publish --repo` now asks **git** what is in the repo, instead of
walking the directory with a list of names to skip. Two consequences:

- **A gitignored file can no longer be uploaded.** That list of names did not
  save `malloy-config-local.json` — Malloy's local override, where the real
  credentials live and which is gitignored for that reason — because it read the
  filesystem rather than git. Now it is not a candidate at all.
- **Anything git tracks is sent, including a committed `docs/`.** If you commit a
  built site for GitHub Pages, it is in the repo, so it goes. To keep it out, use
  git's own mechanism in `.gitattributes`:

  ```gitattributes
  /docs/ export-ignore
  ```

  **Anchor it with the leading slash.** Without one the pattern matches at every
  depth, so a plain `docs/` would also exclude a dataset directory named
  `datasets/docs/` — the identical mistake the old skip list made.

Uncommitted work still publishes, as before: the publish stages into a throwaway
index, so a dataset you have not committed yet is included and your own staged
changes are untouched.

## What does not change

- **You do not need to upgrade the CLI** for the server's sake — the wire format
  is unchanged. You will want the new one for the publish behaviour above.
- **Roles and scoping are untouched.** Who may open a dataset, and the givens it
  is scoped by, work exactly as before and stay per dataset.
- **`malloyyo publish --dataset x` still works** and still behaves the old way —
  those datasets stay outside the repo model for now, with their files stored as
  before.
- **Existing dashboards, saved queries and share links** keep resolving.

---

## Known gaps in this release

Be aware of these before you rely on them.

**There is no repo UI.** No list of repos, no rename, no "attach this repo to
GitHub", no ownership transfer. GitHub settings are still edited on a dataset's
config page, which now applies them to that dataset's repo — so editing them on
any one dataset changes them for all of its siblings, which is correct but is not
what the page looks like it does.

**Rollback is not exposed.** Every revision is kept with its contents, so the
history is there and rolling back is possible — but there is no button and no
command. Today it is a SQL update against `repo_revisions.active`. If you need
this operationally, ask before you need it urgently.

**Revisions are never pruned.** Every publish keeps its full archive in Postgres
(32MB cap each). On a busy instance this grows without bound. There is no cleanup
job yet.

**Symlinked dataset directories do not work** when the repo is pulled from
GitHub. Git stores the link rather than the target, so the server sees a file
where `malloyyo lint` on your own disk sees a directory. It is refused rather
than half-published, but `lint` and the server disagree — the one remaining case
where they do.

**An interrupted "add from GitHub" can leave an empty repo** that serves nothing.
Retrying the same request reuses it; retrying with a different name will say the
repo is already attached. With no repo UI, nothing lists these.

---

## If something goes wrong

The migration changes no existing data in place and drops no columns, so the
pre-upgrade state is still in the database. The health routes behave as they
always have: `/api/healthz` for "did this process start correctly", `/api/health`
for "is it connected to its dependencies". A failed migration fails readiness —
both answer 503 rather than serving on a broken schema.

A publish that fails to compile changes nothing and reports which dataset failed
and why. The previous revision keeps serving throughout.
