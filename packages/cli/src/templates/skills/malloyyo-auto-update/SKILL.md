---
name: malloyyo-auto-update
description: Keep a malloyyo GitHub-Pages data site current automatically with a weekly GitHub Actions job — download from the source URL, transform, export parquet, commit. Use after a site is built (see malloyyo-data-site) when the data comes from a public URL that refreshes over time and you want the published site to track it with no manual steps. Worked example: malloydata/malloyyo-imdb.
---

# Auto-update a data site weekly

The procedure ships with the CLI, so it always matches the `malloyyo` you have
installed rather than whatever was current when this repo was scaffolded:

```
mcp__malloyyo_author__yo_help("site/auto-update")
```

Read it and follow it. Do this **after** the site works — that is
`site/data-site`. If the data never changes, skip it entirely.
