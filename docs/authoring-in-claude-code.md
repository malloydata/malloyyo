# Authoring models in Claude Code on the web

> **Status:** built in [#209](https://github.com/malloydata/malloyyo/pull/209)
> and tested by driving the tools the way a session would. It has not yet been
> run from a real Claude Code on the web session; that, and the default network
> setting, are the open checks.

You write and change Malloy models by talking to Claude. Claude works in a copy
of your model repo, and Malloyyo compiles each change and shows it to you with
real data, dashboards included, before anything is published. Nothing is
installed, and no keys are handled. The only setup is connecting Malloyyo to
Claude.

The model repo on GitHub stays the source of truth. Every change reaches it as
a pull request you review, and publishing happens only after you merge.

## What you need

- **An account on a Malloyyo instance with authoring rights.** Today that means
  an admin.
- **A model repo on GitHub that the instance publishes.** Your admin adds it
  once. Ask them if you're not sure.
- **Access to Claude Code on the web** (claude.ai/code), connected to your
  GitHub account so it can open the repo.

## Set up (once)

1. In claude.ai, open **Settings → Connectors** and add a custom connector with
   your instance's address followed by `/mcp`, for example
   `https://malloyyo.example.com/mcp`.
2. Sign in when asked. Claude now acts as you on that instance, with your
   permissions and nothing more.

That's all. You don't need a special environment, network rules, environment
variables, a setup script or tokens. The default environment works.

## Start a session

1. Open **claude.ai/code** and start a session on your model repo.
2. Make sure the Malloyyo connector is turned on for the session.
3. Say what you want, for example:

   > Add a `returns` dataset from the warehouse's returns table, with a
   > dashboard showing return rate by product category.

   > In the imdb dataset, the dashboards each compute vote totals their own way.
   > Move that into the model and make the dashboards use it.

On its first turn, Claude checks that everything is in place. If something is
missing, it tells you what to do and stops there:

| Claude says | What it means | What to do |
| --- | --- | --- |
| *I don't have Malloyyo's authoring tools* | You're not an author on this instance, or the connector isn't on for this session | Turn the connector on; if it already is, ask an admin for authoring rights |
| *This repo isn't on Malloyyo* | The instance doesn't publish this GitHub repo | Ask an admin to add it, then start again |
| *Preview check passed* | Everything works | Nothing; Claude carries on with your request |

## How a change goes

### 1. Claude looks before it writes

For a new dataset, Claude starts with the data: which tables the repo's
connections can see, their columns, row counts and sample rows. Then it asks you
what the dataset should answer. A model built from your questions is better
than one copied from the schema.

For a change to an existing dataset, Claude reads the model and its dashboards
in the repo.

### 2. Claude edits, and you see it

Claude edits files in its copy of the repo, then sends the changes to Malloyyo
as a **preview**. Malloyyo compiles the repo with those changes, using the
warehouse connections it already has, and reports one of two things:

- **It compiled.** You get a link for every dashboard and an address for every
  dataset. Claude runs queries against the preview to check the numbers.
- **It didn't.** You get the errors, per dataset. Claude fixes them and previews
  again.

This repeats as often as needed. Each round is a single step: nothing is pushed
to GitHub, and nothing changes for anyone else.

Preview links look like this:

```
https://malloyyo.example.com/datasets/shop%40returns-dashboard%3Areturns/dashboard/overview
```

The page carries a banner naming the preview, so it can't be mistaken for the
published dashboard.

### 3. Claude proposes it

When you're happy with it, Claude commits on a branch, pushes, and opens a pull
request. Before you merge, Claude checks what merging would produce. If someone
else changed the repo in the meantime, this is where a merge that applies
cleanly but breaks the model gets caught.

**Merging is your decision.** Claude asks before merging, even when it could
merge itself.

### 4. Publish

After the merge, Claude publishes the repo, or your repo's GitHub hook does it
for you. Everyone with access now sees the change. Any new dataset is created at
this point.

## Previews

A preview is a compiled snapshot of the repo with your changes in it. It is
**never published**.

- **Who can see it:** authors only. Nobody else's dashboards change, and queries
  against a preview don't create share links.
- **Its address:** `repo@label:dataset`, where the label is usually the branch
  name. Any Malloyyo tool that takes a dataset also takes a preview address, so
  Claude can query, describe and show dashboards from a preview exactly as it
  would from published data.
- **A snapshot, not a live view:** a preview shows what was sent. Each new
  preview with the same label replaces what that address shows, and older
  previews stay reachable by commit.
- **New datasets:** a preview can contain a dataset that doesn't exist on the
  instance yet. That's how you try one before it is created.

### Other ways to make a preview

You'll rarely need these from Claude Code, but they exist:

- **A branch on GitHub.** `fetch_branch(repo, branch)` from any Claude, or
  **Fetch from GitHub** on the repo's page. Use it to look at a branch someone
  else pushed.
- **A local checkout.** `malloyyo publish --repo <owner/name> --branch` uploads
  your working tree, uncommitted changes included.

## Draft dashboards

A dashboard made in chat with `save_draft_dashboard` is a **draft**. It lives on
the instance and is listed to everyone who can see the dataset, labelled as a
draft. To make it part of the model, Claude writes it into the repo as
`dashboards/<name>.malloy` plus its component (`get_draft_dashboard` hands it
the files), previews it, commits, and records the promotion.

Once the promoted dashboard is published, **the draft's link opens the
published dashboard instead**, so bookmarks and shared links keep working. The
draft also drops out of the dashboard lists.

A draft's author or an admin can delete it with **Delete draft** on its page,
from Claude, or with `malloyyo draft delete <slug>`. Its link then stops
working.

## When something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Claude can't find the authoring tools | The connector is off, or you aren't an author | Turn it on; ask an admin |
| "This repo isn't on Malloyyo" | The instance doesn't publish it | An admin adds the repo |
| "Base commit … isn't on GitHub" | The commit Claude started from isn't on GitHub | Claude pushes the branch and previews again |
| "… is more than 200" / "… is more than 512KB" | The changes exceed the preview size limit | Claude pushes and uses `fetch_branch` instead |
| A preview compiles, but numbers look wrong | The model, not the tooling | Ask Claude to explain the query it ran |
| The PR check fails but the preview passed | The repo changed since your branch started | Claude updates the branch from main and previews again |

---

## For admins: how it works

### The protocol

Claude Code on the web gives Claude a copy of the repo and two channels out of
its sandbox that need no setup: GitHub, for clone and push, and the claude.ai
connector, which is how it reaches Malloyyo. Previews go over the connector
with **only the changes**:

```
preview_changes(
  repo:    "owner/name",          // as `git remote get-url origin` shows it
  label:   "returns-dashboard",   // usually the current branch
  base:    "<commit sha>",        // git merge-base HEAD origin/<published branch>
  files:   { "datasets/returns/index.malloy": "…", … },   // changed or added
  deleted: [ "datasets/returns/old.malloy" ]
)
```

The server takes the base commit's files, applies the changes, and compiles the
result with the same pipeline as a publish. It stores the result as a preview
snapshot and answers with each dataset's compile status, preview address and
dashboard links.

Where the base comes from:

1. **No GitHub call at all**, when the base is a revision the instance already
   holds. It usually is: the published commit.
2. **One fetch of that commit from GitHub** otherwise, by SHA, on each preview.
   A branch fetched with `fetch_branch` also counts as a held copy of its commit.

Why changes rather than the whole repo: Claude writes tool arguments the way it
writes text, so the cost of a preview scales with what it sends. A changed
dashboard is a few kilobytes; a whole repo is hundreds, every round.

Why the connector rather than the `malloyyo` CLI: the CLI would need network
rules, a token in the sandbox and a version that matches the server. The
connector needs none of these, and its tools are defined by the server, so they
can't fall out of step with it. The CLI remains the tool for local development
and CI.

### Security

- **Only authors can preview, and every preview is admin-visible only.** A
  preview compiles model code nobody has reviewed, running SQL through the
  instance's connections with the instance's credentials. That is the same
  reach publishing has, so it gets the same gate.
- **Warehouse credentials never leave the instance.** Claude's sandbox doesn't
  have them and doesn't need them.
- **A local config is refused.** A `malloy-config-local.json` in a preview is
  rejected, exactly as at publish.
- **Previews are never served as published.** They are stored as revisions that
  are never activated. Their queries mint no share links and write nothing to
  the shared model cache.

### Limits

- Changes per preview: about 200 files or 512KB of text. Beyond that, push the
  branch and use `fetch_branch`.
- Authoring is admin-only for now. Per-repo authors are planned.

### Tools reference

| Tool | Does | Who |
| --- | --- | --- |
| `list_repos` | Repos on the instance: GitHub repo, published branch, datasets, connections, previews | Authors |
| `list_tables` / `describe_table` | What a repo's connections can see: tables, columns, row count, sample rows | Authors |
| `preview_changes` | Preview a working copy's changes against a base commit | Authors |
| `fetch_branch` | Preview a branch as pushed to GitHub | Authors |
| `check_repo` | Compile a commit, or a pull request's merge result, without storing anything | Authors |
| `publish_repo` | Publish the repo's published branch, creating any new datasets | Authors |
| `query`, `describe_source`, `show_dashboard` | Work on published datasets and on preview addresses | Everyone (previews: authors) |
| `save_draft_dashboard` | Save a draft dashboard | Everyone with query access |
| `get_draft_dashboard` | A draft's files, for promoting it into the repo | Everyone who can see the dataset |
| `mark_draft_promoted` | Record that a draft became a repo dashboard, so its link forwards | The draft's author |
| `delete_draft_dashboard` | Delete a draft | The draft's author, or an admin |

`yo_help("authoring/start")` is the guide Claude follows on its first turn.
`yo_help("repo/branches")` covers previews in more depth.
