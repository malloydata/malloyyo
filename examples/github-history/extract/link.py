#!/usr/bin/env python3
"""Build the git-email -> GitHub-login crosswalk.

Commits carry an email; issues and pull requests carry a login. Nothing in the
API joins the two, so this derives the mapping from two independent signals:

  noreply  GitHub's own commit-authoring address encodes the login
           (`1234567+octocat@users.noreply.github.com`).
  squash   a merged pull request's author is the author of the commit that
           landed it -- and squash-merge subjects carry `(#123)`, so the
           commit's `pr_number` links the two directly.
  name     one person commits under several addresses (work laptop, noreply,
           an old employer) under one display name; a name that resolves to
           exactly one login carries that login over to their other addresses.

Writes identities.parquet: one row per (email, login) with the evidence behind
it, so the semantic model can join commits to people and say how sure it is.
(The column is `match_source`, not `source` -- `source` is a Malloy keyword.)
"""
import argparse
import collections
import os
import re

import duckdb

from common import to_table

NOREPLY_RE = re.compile(r"^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$")
BOT_RE = re.compile(r"(\[bot\]$|-bot$|^dependabot|^renovate|^github-actions)", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True, help="directory holding the tables")
    args = ap.parse_args()
    d = args.parquet
    con = duckdb.connect()

    # (email, login) pairs witnessed by a merged PR whose squash commit we have.
    squash = con.execute(
        f"""
        select c.author_email as email, p.author_login as login, count(*) as n
        from read_parquet('{d}/commits.parquet') c
        join read_parquet('{d}/pull_requests.parquet') p
          on p.repo = c.repo and p.pr_number = c.pr_number and p.is_merged
        where c.author_email is not null and p.author_login is not null
        group by 1, 2
        """
    ).fetchall()

    emails = con.execute(
        f"""
        select author_email,
               count(*) as n,
               min(authored_at) as first_seen,
               max(authored_at) as last_seen,
               -- the display name this address commits under most often
               mode(author_name) as name
        from read_parquet('{d}/commits.parquet')
        where author_email is not null
        group by 1
        """
    ).fetchall()

    # Votes per email, plus the unambiguous noreply reading which always wins.
    votes = collections.defaultdict(collections.Counter)
    for email, login, n in squash:
        votes[email][login] += n

    rows = []
    for email, commits, first_seen, last_seen, name in emails:
        m = NOREPLY_RE.match(email or "")
        tally = votes.get(email, collections.Counter())
        top = tally.most_common(1)
        if m:
            login, source = m.group(1), "noreply-address"
            confidence = 1.0
        elif top:
            login, source = top[0][0], "squash-merge"
            # How dominant the winning login is among this email's evidence.
            confidence = top[0][1] / sum(tally.values())
        else:
            login, source, confidence = None, "unmatched", 0.0
        rows.append(
            {
                "email": email,
                "name": name,
                "login": login,
                "match_source": source,
                "confidence": round(confidence, 4),
                "evidence_commits": sum(tally.values()),
                "competing_logins": len(tally),
                "commits": commits,
                "first_commit_at": first_seen,
                "last_commit_at": last_seen,
                "is_bot": bool(login and BOT_RE.search(login))
                or bool(BOT_RE.search(email or ""))
                or "ci-bot@" in (email or ""),
            }
        )

    # Third pass: carry a login across a person's other addresses by display
    # name, but only where that name points at exactly one login.
    by_name = collections.defaultdict(set)
    for r in rows:
        if r["login"] and r["name"]:
            by_name[r["name"].strip().lower()].add(r["login"])
    for r in rows:
        key = (r["name"] or "").strip().lower()
        if not r["login"] and len(by_name.get(key, ())) == 1:
            r["login"] = next(iter(by_name[key]))
            r["match_source"] = "name-match"
            r["confidence"] = 0.75

    rows.sort(key=lambda r: -r["commits"])
    import pyarrow.parquet as pq

    table = to_table(rows)
    out = os.path.join(d, "identities.parquet")
    pq.write_table(table, out, compression="zstd")
    resolved = sum(1 for r in rows if r["login"])
    print(f"  {'identities.parquet':24} {table.num_rows:>7,} rows  "
          f"{os.path.getsize(out)/1024:>8.1f} KiB  "
          f"({resolved}/{len(rows)} emails resolved to a login)")


if __name__ == "__main__":
    main()
