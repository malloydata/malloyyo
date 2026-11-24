---
description: Move an old single-dataset repo (index.malloy at the root) to the datasets/ layout
---

# Convert a single-dataset repo

The old layout put `index.malloy` at the repo root. To move it under `datasets/`:

> **Only before the dataset is published from this repo.** The instance knows a
> repo's datasets by their DIRECTORY, not their name, so once the root dataset
> has been published, moving it to `datasets/<name>/` reads as a new dataset: the
> publish refuses (`not on this instance yet`), and `--create-datasets` would make
> a second dataset rather than move the first. A published single-dataset repo
> keeps the root layout, which stays fully supported.

1. **Pick the dataset's name.** It becomes the directory name and the published
   name, so use what the dataset is already called on the instance — renaming it
   here would publish a second dataset rather than update the first.

2. **Move everything the model owns**, keeping `malloy-config.json` at the root:

       mkdir -p datasets/<name>
       git mv index.malloy *.malloy dashboards datasets/<name>/

   Leave at the root: `malloy-config.json`, `.mcp.json`, `.devcontainer/`,
   `.claude/`, `README.md`, and anything that is not the model.

3. **Fix imports that reached outside the model.** Imports between files that
   moved together still resolve — they kept their relative positions. Only a path
   that pointed at something left behind needs editing, and it needs `../../`
   in front of it.

4. **Verify before publishing:**

       malloyyo lint

   Lint reads the repo the same way the server does, so a clean lint here means
   the server will accept it. It names the file and line for anything that moved
   wrong.

5. **Publish the repo**, not the dataset:

       malloyyo publish --repo <owner/name>

   A dataset that is not on the instance yet needs `--create-datasets`. One that
   is there but belongs to no repo is moved into this one first, by an admin on
   its page ("Move into a repo", choosing `datasets/<name>/`) — then this
   publish refreshes it.

### If the dataset is backed by GitHub rather than pushed

An instance that pulls from the repo needs to learn the dataset moved. The repo's
layout is re-read on every refresh, so pushing the converted repo and refreshing
is enough — but the dataset's recorded directory is set when it is created. If
the refresh reports the dataset as **unpublished** (the repo no longer has its
old directory) and the new directory as **unclaimed**, an admin updates the
dataset's directory on the instance, or re-adds the repo.

Nothing is deleted either way: a dataset whose directory disappears keeps
serving its last model until someone decides otherwise.

---

*This topic is transitional. It exists while repos built on the old
single-dataset layout are still in the wild, and goes away with them — along with
the notice `lint` and `publish` print when they meet one.*
