# Given variables on users and roles

> **Status: design.** Nothing here is built. The schema it needs is in place —
> a `givens` catalog, and `datasets.required_givens` naming rows from it — so
> this is rows and a resolver rather than another migration through every call
> site.
>
> Shipped today: the two built-in givens, `MALLOYYO_EMAIL` and
> `MALLOYYO_ROLES`, which resolve from the session. See
> `docs/roles-and-access.md`.

## The gap

A dataset can be scoped by who is asking, but only by the two things the
session already knows: their address, and the roles they hold. The case that
actually comes up is neither:

> `customer_reports` should be scoped by **ORGANIZATION**. Alice works for
> Acme. Bob consults for Acme and Globex.

Today you can only reach that by making the model compare against
`$MALLOYYO_ROLES` and naming roles after organisations — which conflates "what
Alice may open" with "which company's rows she sees", and breaks the moment
those two need to differ.

## The shape

A given is **required** by a dataset and **satisfied** by a value attached to
the person, or to a role they hold.

```
dataset  customer_reports
         scoped by: [ORGANIZATION]

user     alice@acme.com        ORGANIZATION = acme        ← tried first
role     acme_corp             ORGANIZATION = acme        ← then the roles
         opens: customer_reports
```

Which makes a role two things at once: a set of datasets it opens, and a bag of
values it carries. Granting `acme_corp` gives Alice both the access and the
identity, instead of "add her to the role, and also remember to set her org."

Resolution, in order:

1. a value set on the **user** wins;
2. otherwise, the values from **every role they hold** are collected;
3. nothing found → the query is **refused**, not defaulted.

## The decisions this forces

### One value, or several?

Bob consults for two organisations. Both his roles carry an `ORGANIZATION`, and
there is no honest way to pick one.

**Role-derived values should be a set, and the model's declaration decides what
is legal.** `ORGANIZATION :: string` with two candidates is refused as
ambiguous — naming a winner would make Bob's access depend on a rule nobody can
predict. `ORGANIZATION :: string[]` gets both, and the model writes
`where: org in $ORGANIZATION`.

That puts the choice with the model author, who knows whether the data supports
belonging to two.

A value on the **user** is always singular, and always wins. It is the override
for "Bob is a consultant, but on this instance he is Acme's."

### Nothing satisfies it

Refuse the query. Not a default, not empty. This is the same rule the built-ins
already follow, and it exists because an empty value is not neutral: an empty
`filter<string>` means NO filter, so defaulting would hand every organisation's
rows to the one person nobody could identify.

### Where the values live

A small map on the user row and on the role row:

```
users.given_values   jsonb   { "ORGANIZATION": "acme" }
roles.given_values   jsonb   { "ORGANIZATION": "acme" }
```

Not a table per value. These are a handful of short strings read on every
query, the admin UI edits them as a unit, and a join per request to learn one
string is the wrong trade.

### What a given is allowed to be

Strings, and lists of strings from role collection. Not numbers, not dates, not
filters. A tenant key is an identifier; widening the type widens what a model
can do with it, and every type that is not a string invites a comparison that
silently does something else.

### The catalog stays the gate

A dataset can only require a given that exists in the `givens` catalog, and a
value can only be set for one. That is what makes a typo a refusal instead of a
requirement nothing can ever satisfy — already enforced today:

```
set-dataset-givens ORGANIZATION → {"ok":false,"error":"unknown given(s): ORGANIZATION"}
```

## What does not change

**The two-layer rule.** Roles decide whether you can open a dataset; givens
decide which rows you see inside it. A given variable is still only a
narrowing: it cannot let anyone into a dataset they were not granted.

**The usage gate.** A query must reference at least one of the givens its
dataset is scoped by, or it is refused. A source-level `where:` propagates, so
the ordinary idiom passes for free and a query over an unfiltered source stands
out.

**Publish checks both directions.** A model that does not declare what the
dataset is scoped by cannot be published; one that declares something the
dataset does not require is published with a warning, because nothing will
supply it.

**The local story.** `MALLOYYO_EMAIL=… malloyyo dashboard dev` becomes
`ORGANIZATION=acme malloyyo dashboard dev` — the declared names are the
variables to set, which is already how it works and needs no change.

## Order of work

1. `given_values` on users and roles, and the resolver: user, then roles, then
   refuse.
2. Admin UI: a value field beside each given on the user and role editors, and
   let the dataset checkbox list include non-built-in givens.
3. Creating givens in the catalog — a name, a description, and whether it is a
   list.
4. Reading values from an identity provider instead of storing them, for
   embedded deployments. `external-user.ts` already mirrors a provider's admin
   claim and discards everything else; the same seam takes a claim carrying an
   organisation.

Step 1 is the whole feature. Steps 2 and 3 are the surface for it, and step 4
is the reason to keep the resolver behind one function rather than reading the
columns at each call site.

## An open question

Whether a given should be settable on an **invitation**, so someone arrives
already scoped rather than being granted roles after they first sign in. It
fits the existing shape — invitations already carry a role — but it adds a
third place a value can come from, and three sources with a precedence order is
how this kind of thing becomes unpredictable. Probably worth resisting until
somebody asks twice.
