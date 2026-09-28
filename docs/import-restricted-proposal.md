# Proposal: `import_restricted`

**Status:** draft proposal for discussion
**From:** Lloyd (with Claude), out of the Malloyyo dashboard work
**For:** Michael Toy
**Builds on:** Restricted-mode Malloy (#2817)

## Summary

Add an import form that makes a Malloy file declare its own trust boundary:

```malloy
import_restricted "../index.malloy"
```

The imported file compiles as an ordinary **trusted** model. Everything
written in the importing file is compiled under **restricted mode**: it
can build on what the trusted model exports (derived sources, joins,
views, queries, `given:` declarations) but cannot reach past it (no raw
SQL, no connection access, no other imports, no `##!` flags).

Today restriction is a property of a *compile request*
(`ModelMaterializer.loadRestrictedQuery`). This proposal makes it a
property of a *file*, so every tool that compiles the file (the runtime,
the VS Code extension, a CLI, a server) enforces the same rules without
being told to.

## Motivation

Malloyyo publishes a Malloy model from a Git repo and serves it to people
and to AI agents. Each dashboard is a file in `dashboards/` that imports
the model and adds the queries that dashboard needs:

```malloy
##! experimental { access_modifiers givens }
import "../index.malloy"

given:
  # label="Name frequency" range_min=0 range_max=3 step=0.1
  W_FREQ :: number is 1.0

source: names_vs_target is baby_names extend { … }

# artifact { title="Name explorer" }
query: similar_names is names_vs_target -> { … }
```

Conceptually a dashboard file is a **consumer** of the model: it should see
exactly what the model publishes and nothing more. Nothing enforces that
today. A dashboard file is compiled as a normal model file, so it could use
`duckdb.sql(...)`, `connection.table(...)`, or import another file. The only
thing vouching for it is the author's commit.

That was tolerable while dashboards were only written by the model's
authors. It isn't now:

- **Agents author dashboards.** We are building "scratch" dashboards: an
  agent (Claude, over MCP or through the `malloyyo` CLI) writes a dashboard
  file, the server stores it as a draft, compiles it, and serves it. The
  author is any user who can query the dataset, not the model's owner.
- **Compiling already reaches the database.** Compiling a file fetches
  schemas for its `connection.sql(...)` and `connection.table(...)`
  sources, so compiling an untrusted file means running its SQL on the
  model's connections before any query executes.

Our current workaround shows why this belongs in the language. The scratch
path strips the file's `import "../index.malloy"` and `##!` lines with
regular expressions, validates what's left with `loadRestrictedQuery`, and
only then compiles the file normally. Checked against three real model
repos, it refuses two of them:

| Repo | Imports | Flags | Local `given:` |
|---|---|---|---|
| babynames | `../index.malloy` | `##! experimental { access_modifiers givens }` | yes: slider weights and focus filters |
| ecommerce | `../index.malloy` | `##! experimental.givens` (a form the regex missed) | no |
| auto-recalls | `../auto_recalls.malloy` (not `index.malloy`) | `##! experimental.givens` | no |

Text munging can't reliably find a trust boundary. The compiler can.

## Proposal

### Syntax

The same forms as `import`, under a new keyword:

```malloy
import_restricted "../index.malloy"
import_restricted { baby_names, NAME } from "../index.malloy"
```

A file may have **several** `import_restricted` statements, for example a
dashboard that draws on two models. They must come **before any other
statement**; only comments and `##` document annotations may precede them.
Restriction is then fixed by the parse, before anything is translated.

`import_restricted` follows the snake_case of existing keywords
(`group_by`). `import restricted "…"` is an alternative with no new
reserved word.

### Semantics

1. **Each target compiles as a trusted model**, exactly as if compiled on
   its own: it may use tables, SQL, its own imports and `##!` flags, and it
   is cached like any model.
2. **Its exports enter the importing file's namespace** under the same
   rules as `import` (all exports, or the selected names), with the same
   name-conflict errors between multiple targets.
3. **The importing file is restricted.** It follows restricted mode as
   implemented today, with one change (givens, below):

   | In a file that uses `import_restricted` | |
   |---|---|
   | Sources, joins, views, queries derived from imported names | allowed |
   | `given:` declarations | **allowed** (changed from restricted queries) |
   | `$NAME` references to imported or local givens | allowed |
   | `#` object annotations and `##` document annotations | allowed |
   | `import` (plain) | forbidden |
   | `##!` compiler flags | forbidden |
   | `connection.table(...)`, `connection.sql(...)` | forbidden |
   | `name!type(...)`, `sql_number` / `sql_string` / … | forbidden |

4. **Compiler flags come from the trusted models,** not from the file. A
   restricted file can't write `##!`, but it can only use givens if the
   `givens` experiment is on. So it inherits the `##!` flags of its
   `import_restricted` targets (their union, when there are several), the
   way `loadRestrictedQuery` inherits the extended model's flags today.
   Dashboard files would drop their `##!` lines entirely.

#### Why allow `given:`

Restricted queries reject `given:` ("only `$NAME` references to existing
givens are allowed"). A dashboard file is different: its givens are its
controls. babynames' Name explorer declares three weight sliders and a set
of focus filters that way. Declaring a given adds a typed parameter whose
values are bound by the compiler; it doesn't widen what the file can
reach. So restricted *files* should allow it. Whether restricted *queries*
keep rejecting it is a separate question (see Open questions).

### What the dashboard above becomes

```malloy
import_restricted "../index.malloy"

given:
  # label="Name frequency" range_min=0 range_max=3 step=0.1
  W_FREQ :: number is 1.0

source: names_vs_target is baby_names extend { … }

# artifact { title="Name explorer" }
query: similar_names is names_vs_target -> { … }
```

The same file with `source: x is duckdb.sql("…")` fails to compile, in
every tool, with the existing `restricted-construct-forbidden` diagnostic.

## Implementation sketch

This builds on the #2817 design. Paths are relative to
`packages/malloy/src/`.

### The constraint: the lock is root-wide

Restricted mode's backstop is the zone lock:
`MalloyTranslator.lockZonesIfRestricted()` locks `importZone`,
`schemaZone`, `sqlQueryZone` and `connectionDialectZone` at the top of
`translate()`, so a restricted translator cannot ask the host for anything.
Those zones live on `root` and are shared with every child translator.
`ImportsAndTablesStep` registers the whole document's imports and table
references in them before translation.

So a restricted file cannot compile its trusted import as an ordinary
child. Unlocking the shared zones for the child would unlock them for the
restricted file too.

### The approach: trusted targets arrive precompiled

A restricted translation never reads a target's source. It asks the host
for the target's **compiled model**, and the host produces it with an
ordinary, separate compile.

1. **Grammar** (`lang/grammar/`). Add an `IMPORT_RESTRICTED` token and an
   `importRestrictedStatement` with the same `importSelect? importURL` shape
   as `importStatement`. Add it to the non-reserved identifier list if
   that's the convention for new keywords.

2. **Restriction per translation.** Today `MalloyElement.isRestricted()`
   reads `translator().root.restrictedMode`, and `MalloyToAST` gets the
   flag from the root. Make restriction a property of each translation:

   ```ts
   translation.restricted =
     root.restrictedMode ||            // loadRestrictedQuery, as today
     declaresRestrictedImports(parse)  // this file says so
   ```

   `isRestricted()`, `ASTStep` and `MalloyToAST` read the translation's
   flag. The whole-compile lock stays exactly as it is for
   `loadRestrictedQuery`.

3. **A new need: `trustedModels`.** In `ImportsAndTablesStep`, a restricted
   translation currently returns early and registers nothing. For a file
   restricted by its own syntax, it instead returns
   `{trustedModels: [url, …]}` for its `import_restricted` targets and still
   registers **nothing** in the zones. None of its own table, SQL,
   connection or import references ever reach the host.

4. **The compile loop** (`api/foundation/compile.ts`, `Malloy.compile`).
   On a `trustedModels` need, run an ordinary `Malloy.compile` of each URL,
   with its own translator, zones and model cache, and hand the result back
   through the existing
   `translator.update({translations: {[url]: modelDef}})` path. That's the
   `pretranslatedModels` route `ImportStatement.execute` already honors for
   cached models, and the one `ImportsAndTablesStep` already filters out of
   `missingImports`.

5. **Flags before the AST.** Because the need is raised in
   `ImportsAndTablesStep`, the targets are compiled before `ASTStep` runs.
   The translation can seed `compilerFlagSrc` from the targets' `##!`
   annotations before the AST is built, the same way `TranslateStep` seeds
   from `extendingModel` today.

6. **The statement** (`lang/ast/statements/`). `ImportRestrictedStatement`
   shares `ImportStatement.execute`'s namespace logic (selection,
   conflicts, givens, persist dependencies), but takes the model only from
   `pretranslatedModels` and is permitted when the translation is
   restricted. Plain `import` keeps its restricted-mode rejection.

7. **`given:`** (`ast/statements/define-given.ts`). `DefineGivens.executeList`
   rejects only under the root flag (restricted queries), not for files
   restricted by `import_restricted`.

### Properties this keeps

- **The restricted translation never touches the host.** Its one outward
  request is "the compiled model at this URL", which the host answers with a
  trusted compile it chooses to perform. The host can also refuse, say for
  a URL outside the model's directory.
- **The target doesn't have to be `index.malloy`.** auto-recalls imports
  `../auto_recalls.malloy`, and nothing here depends on the file name.
- **Caching becomes safe.** `Malloy.compile` skips the model cache for
  restricted compiles, because the same URL could compile either way. When
  the restriction is written in the file, a URL always compiles the same
  way, so these files can be cached under their URL.
- **Tools need almost nothing.** The VS Code extension compiles with
  `runtime.loadModel(url)` (`src/server/translate_cache.ts` in
  malloy-vscode-extension), which goes
  through `Malloy.compile`, so authors see restricted-mode errors as they
  type. Its TextMate grammar needs the keyword.
- **`loadRestrictedQuery` is unchanged.** It could later be described as
  compiling a document that `import_restricted`s the model, but nothing
  here requires that.

## Edge cases

- **A restricted target.** `import_restricted "b.malloy"`, where `b.malloy`
  itself uses `import_restricted`, just works: the host's "trusted" compile
  of `b` honors `b`'s own restriction.
- **Plain `import` of a restricted file** from a trusted file, e.g. a model
  importing a dashboard file. The child's translation is restricted by its
  own syntax, so with restriction per translation it raises its own
  `trustedModels` need and registers nothing. Alternatively, v1 could simply
  reject this case.
- **Name conflicts** between several targets use the existing
  `name-conflict-on-*import` errors.
- **Flags from several targets** are unioned. Two models disagreeing about
  an experiment would be unusual; union is the permissive, predictable
  choice.
- **Misplaced statements.** `import_restricted` after another statement is a
  parse-time error: restriction can't begin halfway through a file.
- **Exports.** A restricted file exports its own definitions as usual; only
  where they came from is constrained.

## Open questions

1. **`given:` in restricted queries.** What was the reasoning for rejecting
   `given:` in `loadRestrictedQuery`? Does it apply to restricted files, or
   only to single queries whose values the host binds?
2. **Flag semantics.** `TranslateStep` notes that `##!` flag semantics are
   "still to be settled … not the final design." Is inheriting the targets'
   flags consistent with where that's heading? Would you rather restricted
   files could state a limited set of experiments themselves?
3. **Restriction per translation.** Is moving `restrictedMode` from the root
   to each translation the right seam? Or would you rather keep it
   root-wide and have the compile loop always compile a restricted file as
   its own top-level compile?
4. **Keyword.** `import_restricted "…"` or `import restricted "…"`?
5. **Should hosts be able to require it?** For example, a compile option
   saying "this file must use `import_restricted`". Malloyyo would set it for
   every `dashboards/*.malloy`, so a dashboard that forgot the restriction
   fails rather than silently compiling trusted.

## What Malloyyo would do with it

- Dashboard files switch `import "../index.malloy"` to `import_restricted
  "../index.malloy"` and drop their `##!` lines. `malloyyo lint` warns until
  every dashboard file does; later, publishing requires it.
- Scratch dashboards drop the regex gate. A draft must use
  `import_restricted`, its targets must be files of the dataset's model, and
  Malloy enforces the rest.
- An agent building a dashboard in its editor sees the same diagnostics the
  server will produce, because the rule lives in the file.
