# Malloy model repo

This repo is a Malloy semantic model published by Malloyyo at {{url}}
(the instance "{{instance}}", which knows this repo as `{{repo}}`). Its
connector's tools are tagged `[{{instance}}]`.

## Working here

- Start with `list_repos` and `yo_help("authoring/start")`: the edit →
  `preview_changes` → pull request loop, with real data, before anything is
  published.
- Each dataset is a directory under `datasets/`; `yo_help("repo/datasets")`.
- Connections are in `malloy-config.json`. Secrets are `{"env": "NAME"}`
  references, never values; the instance holds them. To add or change a
  connection, the instance's Setup page: {{url}}/admin/setup
- Work on a branch. Never commit to the published branch; merging publishes.
- Malloy: `#"` is a description, `#` an annotation, `//` a comment.

## Before you propose a change

Preview it (`preview_changes`), check the numbers with `query`, give the person
the dashboard links, then open a pull request and run
`check_repo(pull_request: <n>)`.
