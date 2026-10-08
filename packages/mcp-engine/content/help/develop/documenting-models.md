---
description: Documenting a model — what each description is for, where it shows, and how long it should be
---

# Documenting a model

An AI reading your published model sees it in two steps. `list_sources` comes
first: every source in every model it can see, so it can pick one. Then
`describe_source`, for the source it picked: fields, views, joins, and your
guidance for using it. Each kind of documentation is shown at one of those
steps. Put each thing where it is read, at the size it is read at.

| You write | It becomes | Shown in | Keep it to |
|---|---|---|---|
| `##"` at the top of `index.malloy` | the model's description | `list_sources` | a sentence or two (lint warns past 500 characters) |
| `#"` above a source | the source's description | `list_sources` | one sentence on what the source answers (lint warns past 300) |
| `#(agent)` above a source | the source's instructions | `describe_source` | what someone writing a query must know, in a few short paragraphs |
| `#"` above a dimension, measure or view | its description | `describe_source` | one line |
| `#(agent)` above a field | its instructions | `describe_source` | a line or two, only where the name and type don't say it |

## Why the sizes matter

`list_sources` is read on every question, before anyone knows which source they
need, so every description in it is paid for every time. Ten sources with a
paragraph each make a listing too large to read in one go. The AI ends up
searching it instead of reading it, and can miss the source it needed.

`describe_source` is read once a source has been picked, so it can afford more.
That is where the detail goes.

## The model: `##"`

Two hashes. A single `#"` attaches to the next declaration, so `#"` above the
first source documents that source and leaves the model with nothing.

    ##" Orders, customers and products from the online store, as finance reports them.

Say what the dataset is, and for whom. Leave out how to query it; that belongs
to each source.

## A source: `#"`, then `#(agent)`

The `#"` is how a reader picks this source over the others. Write it as the
questions it answers:

    #" One row per order line: revenue, margin and discounts by product, customer and day.
    #(agent) Revenue is net of returns; use `gross_revenue` for the pre-return figure.
    #(agent) Join `customers` for region; `order_date` is in UTC.
    source: order_items is ...

Each `#(agent)` line is joined with the others into the source's
`instructions`. That is the place for grain, the measure to prefer, a filter
that is almost always wanted, how two similar fields differ, and what the
values of a coded field mean.

A test: if a sentence in the `#"` only helps someone who has already chosen this
source, move it to `#(agent)`.

## Fields and views: one line each

    #" Sales after returns, in USD.
    measure: revenue is sale_price.sum() - returned_amount.sum()

    #" Top products by revenue this year.
    view: top_products is { ... }

`describe_source` shows these next to each name. A view's description is often
all a reader needs to run it, so give every view one.

## Check it

`malloyyo lint` warns when the model has no `##"`, when an exported source has
no `#"`, and when either runs past the sizes above. These are warnings, so
they never block a publish.
