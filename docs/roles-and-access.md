# Roles and access

> **Status: roles ship.** The role catalog, dataset grants, `$MALLOYYO_ROLES`
> and row scoping all work today, managed at **Admin → Roles**. Multi-dataset
> repos (the `datasets/` layout below) do NOT yet — that section describes
> where this is going.

Two questions decide what anyone sees, and they are answered in different
places:

| | question | decided by |
|---|---|---|
| **access** | which datasets may I open? | your **roles** |
| **scope** | which rows do I see inside one? | the **model**, from your identity |

Keeping them apart is what makes the result predictable: a role can never show
you more rows inside a dataset, and a model can never let you into a dataset you
were not granted.

## Roles

Everyone has a **list** of roles, not one.

**Built-in roles** say what you may *do* on this instance:

| role | what it permits |
|---|---|
| `MALLOYYO_USER` | sign in, query the datasets your roles allow, save and share queries, build draft dashboards |
| `MALLOYYO_DEVELOPER` | everything above, plus publish models and create datasets |
| `MALLOYYO_ADMIN` | everything above, plus manage people, roles and instance settings |

**Your own roles** say which datasets you may *open* — `finance`, `operations`,
`sales`, whatever matches how your organisation is actually divided. Name them
after groups of people, not after data: you will be granting them to humans.

A person typically holds one built-in role and one or more of your own:

```
alice@example.com    MALLOYYO_USER, finance
bob@example.com      MALLOYYO_DEVELOPER, finance, operations
carol@example.com    MALLOYYO_ADMIN, finance, operations, sales
```

New people get a **default set** when they first sign in, which an admin
configures. On an open instance keep it narrow — `MALLOYYO_USER` and nothing
else is a reasonable default, so a new arrival can sign in and see nothing
until someone grants them a role deliberately.

`MALLOYYO_DEVELOPER` and `MALLOYYO_ADMIN` cannot be admission defaults, and the
server refuses them rather than hiding them: on an instance that admits anyone
who signs in, that list is applied to every arrival, so one ticked box would
hand the capability to whoever finds the URL.

Roles may eventually be read from your identity provider instead of being
managed here, so that a group membership revoked upstream takes effect on the
next sign-in. Name your roles to match what that system already calls them and
the switch costs you nothing.

## Datasets name the roles that may open them

A dataset lists the roles that grant access to it. Hold one of them and you can
query its sources and open its dashboards; hold none and the dataset is not
there for you — it does not appear in `list_sources`, and a query naming it is
refused the same way an unknown dataset is.

There is no per-source permission inside a dataset. **A dataset is the unit of
access**: everything it publishes, you get. If two groups need different
subsets, that is two datasets — see [Organising a repo](#organising-a-repo).

## Inside a dataset: two givens

A model can ask who is asking. Two values can be supplied by Malloyyo, and
neither can be set by anyone making a query. **An admin ticks which of them a
dataset is scoped by** — declaring one in a model does not scope the data by
itself:

```malloy
##! experimental { givens }
given:
  MALLOYYO_EMAIL :: string is ''
  MALLOYYO_ROLES :: string[]
```

A list given takes no empty default — Malloy has no `[]` literal — and it does
not need one: the server always supplies it, and a query that somehow reached
the model without it would be refused rather than run unscoped.

`$MALLOYYO_EMAIL` is the signed-in address. `$MALLOYYO_ROLES` is the list of
roles that person holds, built-in and your own together.

The two halves check each other. Tick a given on the dataset and a model that
does not declare it cannot be published. Declare one that is not ticked and
nothing supplies it — the model's default applies, and `publish` says so.

Only these two today. The interesting version is the one that is not built in —
`ORGANIZATION` on a customer-reports dataset, satisfied from a value set on the
person or on one of their roles. That is designed but not built; see
`docs/given-variables.md`.

Scope rows by whoever is asking:

```malloy
source: orders is ... extend {
  where: owner_email = $MALLOYYO_EMAIL
}
```

Or by what they belong to:

```malloy
source: tickets is ... extend {
  where: department in $MALLOYYO_ROLES
}
```

Put the filter on the **source**, not in each query. It then holds for every
query anyone writes against it later, including ones an assistant composes for
you, and for dashboards built next year by someone who never read this page.

See `yo_help language/who-is-asking` for the full reference, including how to
run a scoped model on your laptop.

## The one rule: never widen with a role

Roles decide whether a door opens. They must not decide how much is behind it.

```malloy
// DON'T
where: owner_email = $MALLOYYO_EMAIL or 'MALLOYYO_ADMIN' in $MALLOYYO_ROLES
```

That line looks like a convenience and is a trapdoor. Every safety check
Malloyyo applies is built on the assumption that a filter **narrows**: it
verifies your query references the given at all, and refuses to run when the
identity is unavailable. An `or` passes all of it while switching the scoping
off for whoever matches — and nothing, anywhere, will tell you.

Express it as access instead:

```
datasets/orders_mine    scoped by $MALLOYYO_EMAIL   roles: sales, finance
datasets/orders_all     unscoped                    roles: MALLOYYO_ADMIN
```

Now "admins see everything" is a grant you can read off a list, rather than a
clause buried in a `where`. Someone auditing access looks in one place, and the
model stays honest about what it does.

`in $MALLOYYO_ROLES` on its own is fine — it narrows. It is the `or` that is
the problem, not the given.

## Organising a repo

A model repo backs **one dataset** by default — the shape most repos have today:

```
index.malloy            the sources this dataset publishes
dashboards/             its dashboards
malloy-config.json      connections
```

To publish several datasets from one repo, use a `datasets/` directory instead:

```
datasets/
  finance/
    index.malloy        what the finance dataset publishes
    dashboards/
  sales/
    index.malloy
    dashboards/
lib/
  orders.malloy         shared definitions, imported by both
malloy-config.json      connections, shared by all of them
```

- **The directory name is the dataset name.** `datasets/finance/` publishes a
  dataset called `finance`.
- **Each dataset publishes only what its own `index.malloy` exports.** A source
  defined in `lib/` and not exported by `datasets/sales/index.malloy` is not in
  the sales dataset — not hidden from it, genuinely absent, so no query can
  reach it.
- **Dashboards belong to a dataset**, in that dataset's own `dashboards/`. A
  dashboard cannot span datasets; that would cross an access boundary.
- **`lib/` is shared.** Import it with an ordinary relative path:
  `import "../../lib/orders.malloy"`.
- **Use one shape or the other.** A repo with both a top-level `index.malloy`
  and a `datasets/` directory is an error rather than a guess, so you never
  publish half of what you meant to.
- **A change in `lib/` touches every dataset that imports it.** Publishing
  compiles them all, so a shared edit that breaks the sales dataset fails before
  anything ships rather than after.

### Imports carry givens

Worth knowing before it surprises you. A dataset is scoped because its model
**declares** a given — and a plain import brings the givens of the file it
imports:

```malloy
import "../../lib/orders.malloy"          // brings its sources AND its givens
import { orders } from "../../lib/orders.malloy"   // brings only `orders`
```

So if `lib/orders.malloy` declares `MALLOYYO_EMAIL`, every dataset that imports
it plainly becomes scoped — including one you meant to leave open. Publishing
tells you when this happens, and it cannot be undone by publishing again (an
admin has to clear it), so read that line.

If you want a shared library without imposing scoping on everyone who uses it,
either import selectively or declare the given in each dataset's own
`index.malloy`.

### Don't publish the same source name twice

If `finance` and `sales` both publish a source called `orders` with slightly
different joins, anyone holding both roles sees two sources called `orders` and
has to guess — and so does any assistant querying on their behalf.

Prefer roles that **partition** people: grant exactly one of a set of tiers, so
nobody ever sees both. Where people genuinely need both, give the variants
different names — `orders` and `orders_with_support` — so the choice is made on
meaning rather than on which dataset it came from.

## What each person sees

`list_sources` — and every dashboard list, and the home page — shows only the
datasets your roles grant. A dataset you have no role for is not something you
are told you cannot see; it simply is not in the answer.
