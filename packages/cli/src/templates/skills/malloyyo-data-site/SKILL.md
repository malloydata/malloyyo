---
name: malloyyo-data-site
description: Turn a public data URL into a browsable, interactive dashboard site hosted on GitHub Pages, using Malloy (malloyyo). Use when someone points at data on the web (CSV/TSV/Parquet/JSON at an https URL) and wants a public web interface to explore it — scaffold the repo with `malloyyo init`, transform the data into parquet under docs/, write the Malloy model + dashboards, preview with `malloyyo dashboard dev`, build with `malloyyo dashboard bundle`, and publish on GitHub Pages. Worked examples: malloydata/malloyyo-babynames (base) and malloydata/malloyyo-imdb (adds a transform + weekly auto-update).
---

# Build a public data site from a web data pointer

The procedure ships with the CLI, so it always matches the `malloyyo` you have
installed rather than whatever was current when this repo was scaffolded:

```
mcp__malloyyo_author__yo_help("site/data-site")
```

Read it and follow it. It links on to `site/data-to-parquet`,
`site/github-pages`, and `site/auto-update` for the steps that need more detail.

(No `malloyyo_author` server? `malloyyo init` writes the `.mcp.json` that wires
it — that is step 1 of the procedure anyway. Outside an MCP client, the same
text is `malloyyo mcp --develop` → `yo_help`.)
