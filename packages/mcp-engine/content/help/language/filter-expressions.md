# Filter expressions

A filter expression is a small language for saying which values of a field to
keep. It is written as `f'…'` and applied with `~`:

```malloy
where: state ~ f'CA, NY', ordered_on ~ f'last month', amount ~ f'> 100'
```

There is one sub-language per type. An empty expression (`f''`) matches
everything. In every language `null` matches nulls; nulls are excluded with
`-null` for strings and `not null` for numbers, booleans and times. Each
language is ONLY the forms below — SQL (`= 'x'`, `IN (…)`, `BETWEEN`), Malloy
operators, and prose are not filter expressions.

## string

| form | meaning |
|---|---|
| `CA` | equals `CA` |
| `CA, NY, TX` | any of these (comma = or) |
| `-CA` | not `CA` (leading `-` negates one term) |
| `-CA, -NY` | neither |
| `Ann%` · `%son` · `%ann%` | starts with / ends with / contains (`%` and `_` as in LIKE) |
| `-%test%` | does not contain |
| `empty` · `-empty` | empty or null / neither |
| `null` · `-null` | is null / is not null |

A value containing a comma, `%`, `_`, a leading `-`, or quotes is escaped with
a backslash: `Tesla\, Inc.`, `100\%`, `\-leading`.

## number

| form | meaning |
|---|---|
| `5` · `5, 10` | equals / any of |
| `> 5` · `>= 5` · `< 5` · `<= 5` · `!= 5` | comparisons |
| `[10 to 20]` | inclusive range; `(10 to 20)` exclusive, `[10 to 20)` mixed |
| `> 5 and < 10` | both (range by two comparisons) |
| `null` · `not null` | is null / is not null |
| `not …` | negate a clause, e.g. `not [10 to 20]` |

## boolean

`true` · `false` · `null` · `not null`. (`false` matches false-or-null;
`=false` matches only false; `=true` only true.)

## date and timestamp

Moments: a literal (`2025`, `2025-Q2`, `2025-06`, `2025-06-15`,
`2025-06-15 14:30`), `now`, `today`, `yesterday`, `tomorrow`, or a unit phrase
(`this month`, `last week`, `next year`).

| form | meaning |
|---|---|
| `2025` · `2025-06` · `2025-06-15` | within that year / month / day |
| `2025-Q2` | within that quarter |
| `last week` · `last month` · `last year` · `last quarter` | the previous whole unit |
| `this week` · `this month` · `this year` | the current unit so far |
| `7 days` · `3 months` · `2 years` | the last N units up to now (rolling) |
| `7 days ago` · `3 months ago` | the one unit that was N units ago |
| `before 2025-06-01` · `after 2025-06-01` | strictly before / after |
| `through 2025-06-01` | up to and including |
| `2025-01-01 to 2025-06-30` | a range, start inclusive, end exclusive |
| `2025-01-01 for 3 months` | a range of that length from a moment |
| `today` · `yesterday` · `now` | that day / that instant |
| `null` · `not null` | is null / is not null |
| `not …` | negate a clause, e.g. `not last week` |

Literals carry no `@` inside a filter expression. Units: `second(s)`,
`minute(s)`, `hour(s)`, `day(s)`, `week(s)`, `month(s)`, `quarter(s)`,
`year(s)`.

## Writing one from a description

Resolve the description to the forms above for the field's type; prefer the
simplest form that says exactly what was asked. "West coast states" for a string
field whose values include `CA`, `OR`, `WA` is `CA, OR, WA`; "big orders" for a
number field is a comparison the asker should confirm (`> 500`); "the last three
months" is `3 months`; "Q2 last year" is `2025-Q2` if the current year is 2026.
If the description cannot be expressed in the language, say so rather than
approximating — a filter that silently means something else is worse than none.
