---
name: malloyyo-datasets
description: Add a dataset to a malloyyo model repo, or split one dataset into several. Use when someone asks to add a dataset to a repo, or to separate what a repo publishes into more than one dataset. A repo publishes one dataset per directory under datasets/, and publishes as a unit.
---

# Datasets in a malloyyo repo

The procedure ships with the CLI, so it always matches the `malloyyo` you have
installed rather than whatever was current when this repo was scaffolded:

```
mcp__malloyyo_author__yo_help("repo/datasets")
```

Read that first. It covers the layout, adding a dataset, and splitting one
dataset into several.

Two things to get right before you touch files:

- **A dataset's name is its directory name**, slugified — `datasets/the-look/`
  publishes `the_look`. That name is the identity: the URL, what a publish
  matches on, and what a role is granted against.
- **Its title and description are separate**, and presentation only — at model
  scope in its `index.malloy`:

      ##" What this dataset is.
      ## dataset { title="HubSpot CRM" }

  `##"` is the MODEL's doc string; a single `#"` would attach to the next
  declaration instead. Title derives from the name when absent.
- **`malloy-config.json` can be at the repo root** (shared by every dataset) or
  **in a dataset** (its own, replacing the root's). Nearest one wins.

Check your work with `malloyyo lint`, which reads the repo exactly as the server
does — a clean lint means the server will accept it.
