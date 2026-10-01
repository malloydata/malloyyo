---
description: A model repo holds datasets under datasets/ — add one, or convert a single-dataset repo to the new layout
---

# Datasets in a model repo

A model repo publishes **datasets**. Each one is a directory under `datasets/`,
named after the directory:

```
malloy-config.json              connections — shared by every dataset
datasets/
  finance/
    index.malloy                what THIS dataset publishes
    orders.malloy               the model behind it
    dashboards/
      spend.malloy
  sales/
    malloy-config.json          …unless a dataset brings its own
    index.malloy
    dashboards/
lib/                            shared code, imported by relative path
```

`malloyyo init` scaffolds the repo and nothing else — no datasets. You add them.

## The rules worth knowing before you start

- **The directory names the dataset.** `datasets/finance/` publishes `finance`.
  The name is a slug — it is the URL, what a publish matches on, and what a role
  is granted against — so a directory that is not already one is converted:
  `datasets/the-look/` publishes `the_look`. `malloyyo lint` prints the name it
  will publish as, next to the directory.
- **A dataset can say what to CALL it and what it IS**, at model scope in its
  `index.malloy`:

      ##" Deals, contacts and companies, as the sales team sees them.
      ## dataset { title="HubSpot CRM" }

  Note `##"` — two hashes. A `#"` attaches to whatever declaration follows it,
  so `#"` above the first source documents that SOURCE and leaves the dataset
  with no description. The description shows where someone is deciding whether
  they want this dataset, or who should see it.

  With no tag the title is derived from the name — `hub_spot` → "Hub Spot" —
  so a dataset that says nothing still reads properly. Use the tag when the
  mechanical version is wrong: an acronym, a product's own capitalisation.
  The title is presentation ONLY. It is not unique, nothing is looked up by it,
  and changing it renames nothing.
- **A dataset publishes exactly what its own `index.malloy` exports.** A source
  next door is not hidden from it, it is absent.
- **`malloy-config.json` can be at the repo root or in a dataset.** At the root
  it is shared by every dataset. In a dataset it is that dataset's own — and it
  REPLACES the root's rather than adding to it, so a dataset that brings its own
  cannot reach a connection only the root declares. Nearest one wins.
- **The repo publishes as a unit.** Every dataset is linted, and the server
  writes all of them or none.
- **Never have both layouts.** A root `index.malloy` AND a `datasets/` directory
  is refused. A repo with a root `index.malloy` is the old single-dataset shape:
  `yo_help("repo/convert-single-dataset")`.

## Add a dataset

1. Make the directory and its dashboards folder:

       mkdir -p datasets/<name>/dashboards

2. Write the model. Build it the way you build any model — compile a probe to
   read a schema, then write sources into files. `yo_help("develop/getting-started")`
   is the full procedure. Compile with paths relative to the REPO root:

       compile_file("datasets/<name>/orders.malloy")

3. Write `datasets/<name>/index.malloy`, exporting what the dataset publishes:

       import { orders, PERIOD } from 'orders.malloy'
       export { orders, PERIOD }

   Imports inside a dataset are relative to that dataset's directory, so
   `'orders.malloy'` is its sibling. Shared code one level up is
   `'../../lib/orders.malloy'`.

4. Check the repo still publishes cleanly:

       malloyyo lint

5. Publish:

       malloyyo publish --repo <owner/name> --create-datasets

   `--create-datasets` is only needed the first time a dataset appears.

## Splitting one dataset into several

Only worth doing when the datasets really are separate — different people should
see different things, or one of them is scoped by who is asking and the others
are not. A dataset is the unit of access: everything it publishes, a holder of
its role gets.

Move the sources for each into its own `datasets/<name>/`, put anything both need
in `lib/`, and import it with `'../../lib/<file>.malloy'`.

**Watch the givens.** A plain `import "../../lib/x.malloy"` brings that file's
`given:` declarations with it, so a shared library that declares `MALLOYYO_EMAIL`
makes every dataset importing it scoped by the asker. Import selectively —
`import { orders } from '../../lib/x.malloy'` — when that is not what you want.
