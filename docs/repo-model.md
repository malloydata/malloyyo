# The repo model

What a repo is, and why each piece is shaped the way it is. The failures this
replaces are in `docs/repo-model-gotchas.md`; every decision below names which
one it answers.

## The one sentence

**A repo is a row, its content is a zip, and a publish is a pointer flip.**

```
repos ──< repo_revisions ──< malloy_models >── datasets >── dataset_aliases
            (archive: zip)      (active)        (repo_id)     (old names)
            (active)
```

## The tables

### `repos`

One row per repo: `slug`, `owner_id`, and the GitHub attachment
(`github_repo`, `github_branch`, `github_use_token`).

Three things this fixes outright:

- **An owner.** `POST /api/repos/push` shipped with no authority check because
  there was nothing to check against, so any member with a publish token could
  overwrite anyone's datasets. That is not defacement: the archive carries the
  repo's `malloy-config.json`, whose secrets are `{"env": …}` references
  resolved against *this server's* environment, and compiling resolves schemas
  by running SQL.
- **One credential answer.** `github_use_token` was stored per dataset. In the
  production fork one repo had three rows with two values and the refresh picked
  a winner with `rows[0]` on a query with no `ORDER BY` — for a private repo, an
  intermittent 404 that flips between refreshes.
- **GitHub is optional.** `github_repo` null means "published by the CLI, not
  attached to GitHub". One pair of columns used to mean both *these datasets
  belong together* and *GitHub backs this*, so the CLI path had to assert the
  second to say the first: it stamped the author's local branch, and the refresh
  button would then pull `github.com/<slug>@wip` over what had just been pushed.
  Attaching is now a separate act.

`slug` is also the **namespace**: a dataset's public name is `<slug>:<name>`.

### `repo_revisions`

One row per publish — CLI or webhook. Holds the repo as a **zip**, its head
commit, what it declared it publishes, whether it verified, and whether it is
`active`. At most one per repo is, enforced by
`uniqueIndex(repo_id) where active`.

**Why zip.** Gzip is one stream and cannot be read partially. A zip has a
central directory with per-member offsets and independent deflate, so one
dataset's files can be read without inflating the rest — and a member's
*uncompressed size is known before anything is inflated*, which is what lets the
bomb bound be enforced rather than hoped for. GitHub serves a zipball, so the
GitHub path needs no conversion at all.

**Why the content hash, not a hash of the bytes.** `archive_sha256` is what lets
a webhook recognise bytes it already serves instead of minting a revision per
push. A hash of the zip carries the pack timestamp and the compression level, so
it is stable across none of the things that are not the content. It hashes the
normalized file set, which also makes a `.tar.gz` and a zip of the same repo
compare equal.

**Why a flag and not a pointer on `repos`.** `repos.active_revision_id` would be
a circular foreign key, and — more importantly — it would let a repo point at
*another* repo's revision. The flag plus the partial unique index makes that
unrepresentable, and the activation is still one transaction.

### `datasets`

Gains `repo_id` (a real foreign key) and `repo_dir` (`NOT NULL DEFAULT ''`).
Loses `github_repo`, `github_branch`, `github_use_token`.

- **Membership is the foreign key and the status.** It used to be recomputed on
  every refresh by matching two text columns with no status filter; against the
  production fork one repo matched **seven** rows, none of them `ready`, so a
  single webhook push compiled the same model seven times.
- **`''`, not NULL, for the root.** A nullable column cannot be constrained by a
  partial unique index — two `(repo_id, NULL)` rows do not conflict in Postgres
  — so the bug would have come straight back through the constraint meant to
  stop it.
- **Names are scoped to the repo.** `datasets_name_ready_unique` becomes
  `datasets_repo_name_ready_unique`, plus
  `datasets_unscoped_name_ready_unique` for datasets no repo publishes (their
  bare name is still their identity).

**`(repo_id, repo_dir)` is deliberately NOT unique.** Two live datasets on one
directory is a real configuration — the same model served twice, scoped
differently, since `required_givens` and `roles` are the dataset's and not the
model's. Forbidding it would also have made the migration able to *fail on real
data* (a repo added twice under two names is an ordinary thing to find), and a
migration that can fail on rows it did not choose is a landmine in a deploy. So:
**the unit of compile is a directory, the unit of write is a dataset.**

### `malloy_models`

Gains `revision_id` and `active` (`uniqueIndex(dataset_id) where active`).

`active` replaces `ORDER BY created_at DESC LIMIT 1`, which is not a fact but a
guess: two versions written in the same millisecond tie, and the winner is
whichever row Postgres returned. `revision_id` is what makes "are these four
datasets at the same commit?" a column comparison.

Nullable, both of them: a Claude-authored model and the single-dataset
`--dataset x` push have no repo, and nothing historical had to be rewritten.

### `dataset_aliases`

`alias` (primary key) → `dataset_id`. The migration writes one for every
pre-existing repo-backed live dataset.

A plain fall-back-to-bare-name rule is not enough. Without the alias, the day a
second repo publishes its own `sales` every old link to the first becomes
ambiguous. The alias **freezes the historical meaning**.

## Resolution order

`src/lib/repos.ts`, one function, used by every surface:

1. a uuid
2. `repo:dataset`
3. an **alias** — every pre-existing name
4. a repo-less dataset's name
5. a bare name unique across repos
6. **ambiguous → refused, naming the qualified candidates**

Never guessed. Picking one by row order is how the old design chose a credential.

## The publish path

```
normalize the archive  → zip, limits enforced from the central directory
store the revision     → COMMITS, on its own, INERT
materialize            → the repo on a real filesystem in /tmp
layout                 → the engine's rules over an fs lister
compile each DIRECTORY → in its own workspace, with Malloy's own config walk
activate               → one transaction, no I/O — or record why not
```

**No compensating actions.** The old shape inserted `ready` dataset rows,
compiled, and deleted them on failure. That passes every test you can write
against a process that stays alive, and the compile is exactly the slow part a
function timeout lands in the middle of. What survived was `ready` rows with no
model, holding their names under a unique index, with nothing able to release
them: the rightful publish afterwards got a permanent 409.

Here the store commits first and that is *safe*, because nothing reads a revision
that is not `active`. A process that dies anywhere between the store and the
activation leaves a revision nobody looks at and a repo still serving what it
served. The only mutation that makes a publish visible is the activation, and it
touches the database and nothing else.

**Activation never moves a repo backwards.** Two publishes can verify
concurrently and both succeed; the repo row is locked and an older revision steps
aside rather than quietly replacing a newer one.

**Verification is inline.** The call does not return until the answer is known.
A CI job that goes green on a repo that never compiled is worse than one that
goes red.

## Compiling the way the CLI compiles

This is the structural half, and it is why the revision is materialized.

Across three reviews, almost every "lint blessed it, the server refused it" bug
was an in-memory file map behaving unlike a directory tree: `Dirent.isDirectory()`
not following a symlink that `statSync` did, empty files dropped so
`touch index.malloy` deleted a dataset, directories inferred only from the files
that were kept, and a config search that checked two locations where Malloy's own
walks every intermediate one.

So:

1. the zip is written to a real temp directory;
2. the layout rules run over it through the engine's injected-lister interface —
   the same rules `malloyyo lint` applies on the author's disk;
3. each dataset gets its **view** of the repo on disk: its own files at the root,
   the repo's shared files at their repo-relative paths, siblings excluded. The
   model root is `index.malloy`, which every consumer downstream already assumes;
4. the config is found by calling **Malloy's own `discoverConfig`** over that
   filesystem with the repo root as ceiling — the same call `makeRunner` makes
   for the CLI. Not a reimplementation, and not a comment claiming they agree;
5. the compile reads it through a plain filesystem `URLReader`.

The view (`datasetView`) is a **pure function of the path list**, so one rule
renders both the compile workspace on disk and a served model's file map out of
the zip. Two renderings, one rule.

`malloy-config-local.json` in an archive is **refused**, naming the file and
saying to rotate. It is Malloy's local override — by design it holds real
credentials where the shared file holds `{"env": …}` references — and the old
walker read the filesystem rather than git, so gitignore did not save it.
Ignoring it would be worse than refusing: Malloy's discovery *prefers* it, so the
model would compile against different connections locally than here.

## Serving

A repo-backed model's files are derived from its revision
(`src/lib/repo-files.ts`), cached per instance by revision id — immutable, so it
never needs invalidating. `malloy_model_files` rows are no longer written for
them; legacy models still read theirs, chosen by `revision_id IS NULL`.

## Migration

`0026_repos_first_class.sql` is additive and backfills.
`0027_drop_dataset_github_columns.sql` drops the three old columns **as a
separate entry**, because a Vercel build applies the journal *before* promoting
the new code — so the drop must ship in the release after the one that stopped
reading them (see `CLAUDE.md`, and `0014` for the archaeology of getting that
wrong).

The backfill groups the distinct `(github_repo, github_branch)` pairs — exactly
the set the old code treated as a repo — and chooses each disagreeing per-repo
fact **deterministically**:

| fact  | rule | why |
| ----- | ---- | --- |
| owner | the oldest **live** row's owner, else the oldest row's | the person whose dataset is actually serving is the one who publishes |
| token | `bool_or` | a token sent needlessly is ignored by GitHub; a token *not* sent to a private repo is a 404 and a dead dataset. The failure modes are not symmetric |
| slug  | the repo's name, slugified; a collision gets `_2`, with the default branch and then the oldest keeping the bare name | a name nobody chose, and the only alternative that cannot fail. Renameable afterwards |

**Every unique index it creates is implied** either by an index that already
exists or by its own backfill, so the migration cannot fail on data it did not
choose. `test/repo-migration.test.ts` replays the journal to 0025, seeds the
shapes the fork actually held, and checks all of it.

## What is NOT in this

- **`--dataset x` publishes stay repo-less.** `POST /api/datasets/:id/model/push`
  sends a file list, not an archive, and still writes `malloy_model_files` rows
  and no revision. The wire is untouched and so is the behaviour; unifying it
  means synthesizing an archive and giving those datasets a repo, which changes
  their public name.
- **`compiled_model_def` is still filled lazily** on the request path, though the
  verify has a compiled model in hand and could store it eagerly.
- **The archive lives in Postgres `bytea`**, capped at 32MB. Blob storage is the
  obvious next step and changes one module.
- **Old revisions are never pruned.** Every publish keeps its archive.
- **No UI** for repos: no list, no rename, no "attach to GitHub" form. The
  dataset config page still posts its GitHub fields to
  `PATCH /api/datasets/:id`, which applies them to the repo.
