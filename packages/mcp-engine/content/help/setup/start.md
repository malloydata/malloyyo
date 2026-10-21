---
description: Guided setup of a new Malloyyo instance — from an empty instance to a published model with dashboards, connected database and GitHub. Start here when setup_status (or the server instructions) says the instance has no datasets.
---

# Guided setup

You're walking an admin through setting up their Malloyyo instance: a private
GitHub repo for the model, a database connection, a first semantic model and a
dashboard or two, and publishing from GitHub. Go one step at a time. Say what
each step is for, wait for the person, and confirm before moving on. Anything
with a link, the person does in their browser; tell them to come back and say
when it's done.

**Secrets never go in the chat.** Database passwords, keys and tokens are typed
on this instance's Setup page, which stores them in the instance's environment.
If someone pastes one into the chat anyway, don't repeat it or use it: tell them
to enter it on the Setup page, and to rotate it if the chat could be shared.

Call `setup_status` first, and again whenever you're unsure where things stand.
It returns where the instance runs (`platform`), whether authoring is on, the
repos, whether the GitHub token and webhook secret are set, and the Setup page
links (`links.*`; fill in the `{…}` parts).

## 0. Are you in Claude Code?

This needs a session with a clone of the model repo and git: **Claude Code on
the web**. A Claude Code session always starts on a GitHub repo, so the repo
comes first.

If you have no filesystem or git (a claude.ai chat):

1. Ask what to call the repo (default `malloy-models`) and which GitHub account
   or organization should own it. They can transfer it to another owner later
   (GitHub repo → Settings → Transfer).
2. Send them to `https://github.com/new?name=<name>&visibility=private`.
   **Private** is the default. Ask them to tick **Add a README file**, so the
   repo has a first commit.
3. Then give them this link, with their `owner/name` filled in:
   `https://claude.ai/code?repositories=<owner/name>&prompt=Set%20up%20Malloyyo%20%E2%80%94%20follow%20yo_help(%22setup%2Fstart%22)`
   The Malloyyo connector carries over to Claude Code. If its tools are missing
   there, they turn the connector on for that session.

Stop there; the Claude Code session continues from step 1.

If you're in Claude Code on a repo, check it's the right one (`git remote get-url origin`).

## 1. Turn on authoring

If `setup_status` says `authoring: false`, send them to `links.authoring`.
- **Malloyyo Cloud:** one button, then the instance restarts (about a
  minute). Tool calls fail while it restarts.
- **Vercel or self-hosted:** the page shows exactly what their operator sets.

Authoring tools (`add_repo`, `preview_changes`, `test_connection`, …) appear
once it's on. If they still don't appear after the restart, the person
reconnects the connector or starts a new session on the same repo, and you
resume here from `setup_status`.

## 2. Register the repo and scaffold it

1. `add_repo(github: <git remote get-url origin>)`. It registers the repo and
   publishes nothing. Note the `repo` name it returns; the tools use it.
2. Make a branch: `git checkout -b claude/setup`.
3. `get_scaffold(repo)`. Write its files into the repo root: `CLAUDE.md`,
   `.claude/skills/…`, `.gitignore`, `datasets/.gitkeep`, and a placeholder
   `malloy-config.json`. Don't overwrite anything already there without
   asking. Commit: "Scaffold the Malloyyo model repo".

## 3. Where's the data?

Ask where the data they want to model lives. Guided setup handles
**MotherDuck**, **BigQuery** and **Postgres** (`setup_status.connectionKinds`
says what each needs). For anything else, their operator configures the
connection by hand (`yo_help("develop/connection-setup")`); then skip to step 5.

- Pick a connection name with them: short and lowercase, like `warehouse`.
  Secrets are stored under names derived from it (`WAREHOUSE_PASSWORD`).
- Ask for the **non-secret** settings in the chat, never the secret:
  - Postgres: host, port, database, user (a read-only user is best)
  - BigQuery: project id
  - MotherDuck: database (optional)

## 4. Connect it

1. Build the link: `links.connection` with `kind` and `name` filled in, plus
   each non-secret setting as a query parameter, e.g.
   `…/admin/setup?step=connection&kind=postgres&name=warehouse&host=db.example.com&databaseName=sales&username=reader`.
   The page arrives prefilled; they type only the secret.
2. What they do there depends on `platform`:
   - **cloud:** **Test & save**. The page tests the credential first, then saves it, and the instance restarts (about a minute).
   - **vercel / self-hosted:** the page names the variables. They (or their operator) add them and redeploy or restart, then press **Test what's set**.
3. When they say it's done, call `test_connection(kind, name, settings)` with
   the same settings. On success it returns the `malloy-config.json` to write:
   secrets appear only as `{"env": …}` references. Replace the placeholder with
   it and commit.

If it fails, the error says why: a variable not set yet, a wrong password, a
host that's unreachable from the instance (firewalls often need to allow the
instance's address). Send them back to the page.

## 5. Interview before you look

Before exploring tables, talk to the person. A model built from their
questions is far better than one copied from the schema. Ask:

- What decisions should this help with, and who will use it?
- What are the main things they track (orders, customers, sessions…), and how
  are they connected?
- Which numbers matter, and exactly how are they defined (revenue net of
  refunds? active means what?)
- **Do they have SQL for reports or dashboards they use today?** Ask them to
  paste a few queries. Those are the best spec there is: tables, joins, metric
  definitions, the filters people actually use.
- Which dashboard do they wish they had?

Then confirm what you heard in a few lines before building.

## 6. Build, then let them try it

1. Look at just the tables you need: `list_tables(setup_connection: {kind, name, settings})`,
   then `describe_table(setup_connection: …, table: …)` for columns and sample rows.
2. Write `datasets/<name>/index.malloy`. The directory names the dataset, so make
   it a short lowercase slug.
   - Sources with joins, dimensions and measures named in the person's own words.
   - `#"` descriptions on every source and measure.
   - Their pasted SQL becomes measures and named views.
   - `yo_help("repo/datasets")` and `yo_help("develop/working-with-models")` cover the details.
3. One or two dashboards in `datasets/<name>/dashboards/`, answering the
   questions from the interview (`yo_help("dashboards/authoring")`).
4. `preview_changes(repo, label: "claude/setup", files: <every file in the repo>)`,
   with **no base**: the instance can't read a private repo until step 7. Fix
   what it reports, then check numbers with `query` on the preview address.
5. Give them the dashboard links and ask them to try them. Iterate: edit, then
   preview again.

## 7. Connect GitHub, so merging publishes

Commit and push the branch. Then send them to `links.github` with `{repo}` as
their `owner/name`. The page covers two things:

- **A token** that lets the instance read this repo:
  - Create a *fine-grained* personal access token for **only this repository**, with **Contents: Read-only** (the page links to GitHub's form).
  - Pick an expiry they'll remember; when it expires, publishing stops until they replace it.
  - **Cloud:** they paste it and press **Test & save**. **Elsewhere:** their operator sets `GITHUB_TOKEN`, then they test it.
- **A webhook**, so a merge publishes:
  - The page makes a secret and shows the repo's webhook URL and settings.
  - They add the webhook on GitHub: payload URL, `application/json`, the secret, just the push event.
  - Outside Cloud, the operator also sets `GITHUB_WEBHOOK_SECRET`.

Confirm with `setup_status`: both `github.tokenSet` and `github.webhookSecretSet`
should be true.

## 8. Merge and publish

1. Open a pull request from `claude/setup`, using the session's PR button or
   GitHub's REST API.
2. `check_repo(repo, pull_request: <n>)`: now the instance can read it.
3. **Merging is the person's decision.** Ask them to merge. The webhook publishes
   it; within a minute or two `list_repos` shows `liveCommit` as the merge
   commit, and `list_sources` shows the new dataset.
4. If nothing publishes, say so and offer `publish_repo(repo)` as a separate,
   explicit step.

## 9. Bring in the team

- Share the instance's address. People sign in there and connect their own
  Claude with the connector URL (`links.mcp`).
- Roles decide who sees which dataset: Admin → Roles (and Users, or the
  hosting provider's members page).
- From now on, changes go through `yo_help("authoring/start")`: edit,
  `preview_changes`, pull request, merge.
