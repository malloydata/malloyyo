# Testing a model

A model that compiles is not a model that answers questions. Compiling proves
the Malloy is valid; it proves nothing about whether an agent that has never
seen your data can find the right measure, pick the right grain, or notice that
`revenue` and `net_revenue` are different things.

The only way to know is to be the consumer.

---

## The dress rehearsal

```bash
malloyyo test
```

This launches Claude wired to **only** the explore surface — the same engine
code the hosted `/mcp` endpoint runs, restricted the same way, seeing only what
`index.malloy` exports. Not an approximation of the web experience. The same
one.

It deliberately starts with `--strict-mcp-config`, so your other MCP servers are
dropped for that session. That's the point: on claude.ai, your model is the only
tool in the room. If the agent can only answer by reaching for a filesystem or a
web search, you've learned something.

**Run it in a second pane.** Author in one, test in the other. The loop you want
is: change the model, ask the question again, watch what happens differently.

## What to ask

Ask the questions your users will actually ask, in the words they'll actually
use. Not "group orders by month" — that's a query you already know works. Ask:

```
> how did we do last quarter?
> which brands are growing?
> why is the West down?
```

Vague, ambiguous, business-shaped questions are the test. They're what your
model will be handed.

## Reading the results

You're watching two things.

**Did it get the right answer?** Check the numbers, the same way you did while
authoring. An agent that confidently reports a wrong total is the failure mode
this whole system exists to prevent, and the place it still gets in is a
measure that's defined wrong.

**How hard did it have to work?** This is the signal people miss. Watch for:

| what you see | what it means |
|---|---|
| It hunts through several `describe_source` calls before finding a field | Names aren't carrying their meaning. Rename, or add a description. |
| It builds a measure by hand that you thought you'd defined | Either you didn't export it, or it isn't discoverable. |
| It computes something in prose after the query instead of in Malloy | A missing measure, or a pattern it needs a view for. |
| It picks the wrong grain — daily when you meant monthly | Add the view that makes the intended grain obvious. |
| It gives up, or hedges | The model genuinely can't answer. Decide whether it should. |

**When the agent flounders, that's a model bug, not an agent bug.** Fix it in
the model — a clearer name, a missing measure, a join that isn't there, a `#"`
description on the field that keeps getting misread. Then ask again.

This is why testing before publishing is worth the time: every one of these
fixes is cheap now and expensive after someone else hits it.

## Descriptions are documentation the agent reads

A `#"` doc comment on a source, field, or view is carried through to
`describe_source`. It's the highest-leverage thing you can add to a model that
tests badly:

```malloy
#" Net of refunds and cancellations. Use this, not `revenue`, for anything
#" reported externally.
measure: net_revenue is (amount - refund_amount).sum()
```

If a human would need that sentence, so does the agent.

## Dashboards

Two commands, both worth running before every publish.

**Preview them:**

```bash
malloyyo dashboard dev
```

Serves your `dashboards/` against the local model with live reload, so you can
click the controls and see real data. Tag-only dashboards render in the page;
custom ones run in a sandboxed iframe, matching how the server serves them.

**Lint them:**

```bash
malloyyo lint
```

Every check is local to one dashboard file, and it catches the class of problem
that only shows up in production otherwise:

- `index.malloy` still compiles on its own — it's the MCP and ltool surface, and
  it's validated separately from the dashboards.
- Every `dashboards/*.malloy` compiles **as its own entry**, so a bad import or
  an unresolved given fails loudly, on its line.
- No duplicate dashboard names, and no orphaned component file with no matching
  `.malloy`.
- Every tile compiles in that dashboard's scope.
- Every `# suggest {…}` compiles **exactly as the runtime will build it** — this
  is the one that saves you, because a broken suggestion only surfaces when a
  user clicks the control.
- Every `# drill { to= }` target resolves to a real dashboard. Drill targets are
  opaque tag text that Malloy itself never checks.
- Any custom component transpiles, and its hard-coded `query="…"` literals still
  resolve.

Warnings never fail the lint; errors exit non-zero. **`publish` runs the lint
first** and refuses to send a broken dashboard, so this is a preview of whether
your publish will go through. `--skip-lint` overrides it if you need to.

**One thing lint does not catch:** it *transpiles* a custom component, it doesn't
bundle it, so an import that can't resolve — most easily `import { Panel }`,
which is not part of the `@malloyyo/dashboard` surface — passes lint and then
fails when the dashboard is opened. `malloyyo dashboard dev` does bundle, so
loading each custom dashboard once in the preview is the check that catches it.

## Checking it by hand, in VS Code

Nothing about this workflow requires you to test through an agent. The model is
plain Malloy in a git repo, so you can open the folder in VS Code with the
[Malloy extension](https://marketplace.visualstudio.com/items?itemName=malloydata.malloy-vscode)
and work the way you would on any other code: write a query, run it, look at the
rendered result, adjust.

This is the fastest loop when you already know what you want to check — a
measure you're verifying against a number you trust, a join you're not sure
about, a filter that should have excluded something.

**Your dashboard layouts preview there too**, because the layout tags are the
extension's own renderer tags. `# dashboard {columns=6}`, `# colspan`, `# break`,
`# line_chart`, `# bar_chart`, `# shape_map` — run the dashboard's query in VS
Code and you see the cards laid out the way the runtime will draw them.

What VS Code does **not** know about is the Malloyyo layer on top:

| | |
|---|---|
| `# artifact` | Just an unrecognized tag — VS Code won't treat the query as a dashboard |
| Givens and controls | No control bar; supply given values yourself to run the query |
| `# drill` | No click-through between dashboards |
| Custom components | Not rendered at all |

So: **VS Code to check the query and its rendering; `malloyyo dashboard dev` to
check the dashboard** as a user will meet it. They're complementary, and both are
faster than publishing to find out.

## Before you publish

- The questions your users will ask get right answers, in the model's own terms
  (`malloyyo test`), and the numbers hold up when you check them yourself.
- Measures reconcile against a number you already trust.
- `export {}` names exactly the public surface — no staging sources leaking.
- `malloyyo lint` is clean.
- Secrets are `{ "env": … }` references, and you know which variables the server
  will need set.

---

**Next:** [Dashboards](dashboards.md) · [Publishing](publishing.md)
