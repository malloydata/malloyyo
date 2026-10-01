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

- **A dataset's name is its directory name**, and it is what the instance
  publishes it as.
- **`malloy-config.json` stays at the repo root.** Connections belong to the
  repo, not to a dataset.

Check your work with `malloyyo lint`, which reads the repo exactly as the server
does — a clean lint means the server will accept it.
