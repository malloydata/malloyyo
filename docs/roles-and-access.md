# Roles and access

> **Status: shipped.** The role catalog, dataset grants, `$MALLOYYO_ROLES`, row
> scoping and multi-dataset repos all work today. Roles are managed at
> **Admin → Roles**; `lloydtabb/malloyyo_examples` is a live multi-dataset repo.

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
| `MALLOYYO_ADMIN` | everything above, plus create datasets, publish models, and manage people, roles and instance settings |

Two, not three. There was a `MALLOYYO_DEVELOPER` for someone who should ship
models without administering people, and it could not mean that: a dataset names
a repo this server compiles, and a model can define `duckdb.sql(...)` sources and
a `malloy-config.json` whose connection secrets resolve against the server's own
environment. Publishing is therefore as reaching as administering, whatever the
role is called. It comes back when compiling a repo's model is contained.

**Your own roles** say which datasets you may *open* — `finance`, `operations`,
`sales`, whatever matches how your organisation is actually divided. Name them
after groups of people, not after data: you will be granting them to humans.

A person typically holds one built-in role and one or more of your own:

```
alice@example.com    MALLOYYO_USER, finance
bob@example.com      MALLOYYO_USER, finance, operations
carol@example.com    MALLOYYO_ADMIN, finance, operations, sales
```

New people get a **default set** when they first sign in, which an admin
configures. On an open instance keep it narrow — `MALLOYYO_USER` and nothing
else is a reasonable default, so a new arrival can sign in and see nothing
until someone grants them a role deliberately.

`MALLOYYO_ADMIN` cannot be an admission default, and the server refuses it
rather than hiding it: on an instance that admits anyone who signs in, that list
is applied to every arrival, so one ticked box would hand the instance to
whoever finds the URL.

Roles may eventually be read from your identity provider instead of being
managed here, so that a group membership revoked upstream takes effect on the
next sign-in. Name your roles to match what that system already calls them and
the switch costs you nothing.

## A role sets a level on each dataset

A role is a list of datasets, and for each one, what its people get there:

| level | what it lets them do on that dataset |
|---|---|
| **None** | nothing: the dataset is not there for them |
| **Dashboards** | open its dashboards, and nothing else |
| **Full** | open its dashboards, and query it — the query editor, chat, AI Q&A, the MCP connector, draft dashboards |

Set them at **Admin → Roles**: pick a role, and each dataset has one three-way
switch.

```
clients      Client reports: Dashboards
analysts     Client reports: Full     Finance: Full     Support: Dashboards
```

**Someone with several roles gets the most any of them gives, dataset by
dataset.** Hold `clients` and you read the dashboards on Client reports. Hold
`analysts` too and you can query it. The **People** section of the same page
works this out for you: beside each person is what their roles add up to, a row
opens to show which role is why, and *Edit roles* previews the result of a
change before you save it.

There is no "dashboard-only user" to configure. Someone is dashboard-only
exactly when no role gives them Full on anything; their home page is then the
dashboards they can open, with no query editor, chat or connector offered,
because for them there is nothing those could reach. The same person can query
one dataset and only read dashboards on the next.

Where Dashboards shows:

- The dataset's dashboards open as usual; the ways into its data that are not a
  dashboard — AI Q&A, Query, Chat, config, *Explore in Claude* — are left off.
- It is absent from `list_sources`, from the query editor's and chat's source
  lists, and a query naming it is refused the same way an unknown dataset is.
- A draft dashboard cannot be saved on it. A draft is built from queries its
  author wrote.

`MALLOYYO_ADMIN` has Full on every dataset, always; it has no switches.
`MALLOYYO_USER` is a role like any other here — give it a level on a dataset to
open that dataset to everyone who holds it.

Every grant made before levels existed is Full, which is what it always meant.

**Dashboards is a product tier, not a wall around data.** A dashboard runs
queries against its dataset, so someone at the Dashboards level can still reach
whatever that dataset contains. What they must not see goes in a dataset they
have None on, or behind the model's own row scoping (below) — which applies to
dashboards the same as to queries. The usual shape is a dataset curated for the
audience, opened at the Dashboards level.

### Seeing what someone sees

An admin can **view as** any non-admin: *View as* beside a person on Admin →
Roles opens the app exactly as that person sees it — their datasets, their
dashboards, their rows under row scoping, and no admin pages. A bar across every
page says who you are viewing as and how to stop.

**Queries run as them.** Dashboards load their data and the query editor's Run
works, both with that person's datasets and their rows under row scoping. That
is the way to test a multi-tenant dataset: view as one tenant's user, run the
query, and see exactly the rows they would.

Otherwise it is look-only. Nothing is saved, changed or created as them: a
query you run is not added to their history and cannot be saved, and chat,
favourites, tokens, sharing and drafts are refused. Starting, stopping and each
query run this way are logged against you, and it ends by itself after an hour.

## Datasets name the roles that may open them

Seen from the dataset's side, the same settings are a list: the roles that have
any level on it. Hold one of them and you can open its dashboards — and query
its sources, if one you hold has Full. Hold none and the dataset is not there
for you: it is in no menu, it does not appear in `list_sources`, and a query
naming it is refused the same way an unknown dataset is.

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
datasets/orders_all     unscoped                    roles: (none — admins only)
```

An admin opens every dataset, so a dataset no role is given is one only admins
reach. Now "admins see everything" is a dataset you can read off a list, rather
than a clause buried in a `where`. Someone auditing access looks in one place, and the
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
                        (a dataset may bring its own, which then replaces it)
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
- **A change in `lib/` touches every dataset that imports it.** Adding the repo
  compiles them all, and one webhook refreshes them all — so a shared edit that
  breaks the sales dataset fails before anything ships, and the datasets in a
  repo never sit at different commits.
- **A repo lands whole or not at all.** Every dataset name is checked before any
  is created, and if one fails to compile, none are. An instance missing one of
  four datasets looks complete, and the missing one is the one nobody checks.
- **Every directory under `datasets/` needs its own `index.malloy`.** One that
  has none is an error naming it, not a directory quietly skipped. Shared code
  goes in a sibling like `lib/`, not under `datasets/`.
- **Local tooling takes the dataset directory.** `malloyyo dashboard dev -C
  datasets/finance`, since that is where the model rooted.

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

## Who sees a dashboard

Being able to open a dataset shows you its dashboards — except the ones that
are **private**. Every dashboard, draft or published, has the same two
settings, in the same place: the **Share** button beside its name.

- **General access.** *Restricted* (private): only the people listed.
  *Everyone on the dataset*: anyone who can open the dataset, and it is in
  their menu.
- **People.** Email addresses it is shared with.

**A private dashboard is seen by:**

- admins,
- its author, if it is a draft,
- the people it has been shared with.

To everyone else it is not there: it is missing from every menu and from
`list_sources`, and its URL answers "not found". Dashboards are shared with
people, never with roles: a role decides a dataset, and a dashboard decides its
own audience.

What each kind starts as:

- **A draft starts private.** Its author and admins see it until its author
  opens it or shares it. (Drafts that existed before this was introduced were
  listed to everyone, and still are.)
- **A published dashboard starts open**, unless its tag says otherwise:

  ```malloy
  # artifact { title="Board numbers" private }
  query: board_numbers is orders -> { … }
  ```

  The tag decides only what it starts as. Once an admin changes it in the Share
  dialog, that setting stands, and later publishes do not undo it.

Who may change it: a draft's author or an admin for a draft; an admin for a
published dashboard.

**Promoting a draft does not change who can see it.** When an admin records
that a draft was promoted into the model (any admin, for anyone's draft), the
published dashboard takes the draft's general access and its people — whatever the promoted file's tag says — and the draft's author is
added to its people if it is private, so they do not lose their own dashboard
the day it ships.

Sharing **never opens a dataset**. The person still needs a role that gives
them Dashboards or Full on the dataset the dashboard is built on; share with
someone who has neither and the dialog says so beside their name, and the share
takes effect once they are given one.

**This narrows a menu; it is not a security boundary.** Anyone who can open one
dashboard on a dataset can query all of that dataset through it. A private
dashboard hides a view, not the rows behind it. If two audiences must not see
each other's data, that is two datasets — see [Organising a
repo](#organising-a-repo).

## What each person sees

`list_sources` shows the datasets you have Full on. Every dashboard list, and
the home page, shows the ones you can open — those, plus any you have
Dashboards on. A dataset you have no role for is not something you
are told you cannot see; it simply is not in the answer. The same goes for a
private dashboard nobody shared with you.
