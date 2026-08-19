#!/usr/bin/env python3
"""Turn the raw GitHub API payloads in raw/ into the parquet tables.

The payloads are whatever the collector dropped in raw/ -- one JSON document per
API page. Two envelope shapes are understood: the bare JSON a REST page returns,
and the [{"type":"text","text":"<json>"}] wrapper an MCP tool result uses.

Records are classified by shape rather than by filename, so re-running after
adding more pages is safe: everything is de-duplicated on (repo, number).
"""
import argparse
import collections
import glob
import json
import os
import re

from common import write

BOT_RE = re.compile(r"(\[bot\]$|-bot$|^dependabot|^renovate|^github-actions)", re.I)


def load_payloads(raw_dir):
    """Yield (filename, parsed_json) for every payload in raw_dir."""
    for path in sorted(glob.glob(os.path.join(raw_dir, "*"))):
        if os.path.isdir(path):
            continue
        try:
            doc = json.load(open(path))
        except json.JSONDecodeError:
            continue
        # MCP tool results arrive wrapped in a content-block envelope.
        if (
            isinstance(doc, list)
            and doc
            and isinstance(doc[0], dict)
            and doc[0].get("type") == "text"
        ):
            try:
                doc = json.loads(doc[0]["text"])
            except json.JSONDecodeError:
                continue
        yield os.path.basename(path), doc


def records(doc):
    """Unwrap the handful of list-shaped envelopes the API/MCP layer returns."""
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict):
        for key in ("issues", "pullRequests", "pull_requests", "releases", "items"):
            if isinstance(doc.get(key), list):
                return doc[key]
    return []


def kind(rec):
    if "tag_name" in rec:
        return "release"
    if "diff_hunk" in rec or "pull_request_review_id" in rec:
        return "review_comment"
    if "submitted_at" in rec and "pull_request_url" in rec:
        return "review"
    if "issue_url" in rec and "body" in rec:
        return "issue_comment"
    if "head" in rec and "base" in rec:
        return "pull_request"
    if "number" in rec and "title" in rec:
        # The REST /issues stream returns pull requests too; those are richer
        # on the /pulls stream, so let that one own them.
        return None if "pull_request" in rec else "issue"
    return None


def is_bot(login):
    return bool(login and BOT_RE.search(login))


def repo_of_pr(rec):
    base = (rec.get("base") or {}).get("repo") or {}
    if base.get("full_name"):
        return base["full_name"]
    url = rec.get("html_url") or ""
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", url)
    return m.group(1) if m else None


# https://api.github.com/repos/OWNER/NAME/issues/12 -> ("OWNER/NAME", 12)
API_URL_RE = re.compile(
    r"https://api\.github\.com/repos/([^/]+/[^/]+)/(?:issues|pulls)/(\d+)"
)


def repo_and_number(rec, *fields):
    for field in fields:
        m = API_URL_RE.match(rec.get(field) or "")
        if m:
            return m.group(1), int(m.group(2))
    return None, None


def repo_of_issue(rec):
    """REST issues carry their repo; MCP-sourced ones do not."""
    m = re.match(r"https://api\.github\.com/repos/([^/]+/[^/]+)$", rec.get("repository_url") or "")
    if m:
        return m.group(1)
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/issues/", rec.get("html_url") or "")
    return m.group(1) if m else None


def repo_of_release(rec):
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/releases/", rec.get("html_url") or "")
    return m.group(1) if m else None


def attribute_issues(issue_pages, pr_numbers):
    """Issue list payloads carry no repo field, so infer it.

    An issue number and a pull-request number are drawn from one sequence per
    repo, so a page of issues can only belong to a repo whose PR numbers it
    does NOT collide with. That is decisive here and self-checking: if it ever
    stops being decisive the loader says so instead of guessing.
    """
    out = []
    for name, page in issue_pages:
        nums = {r["number"] for r in page}
        # Collision-free is the hard filter; among survivors the winner is the
        # repo whose numbering the page sits inside (a page of issues numbered
        # in the 3000s cannot belong to a repo that has only reached 147).
        fits = [
            (max(0, max(nums) - max(prs)), repo)
            for repo, prs in pr_numbers.items()
            if nums and prs and not (nums & prs)
        ]
        fits.sort()
        if not fits or (len(fits) > 1 and fits[0][0] == fits[1][0]):
            raise SystemExit(
                f"cannot attribute {name} to a repo (candidates: {fits or 'none'}); "
                "collect issues per-repo into labelled subdirectories instead"
            )
        for rec in page:
            out.append((fits[0][1], rec))
    return out


def logins(items):
    """requested_reviewers / assignees arrive as user objects or bare logins."""
    out = []
    for x in items or []:
        if isinstance(x, dict):
            x = x.get("login")
        if x:
            out.append(x)
    return out


def norm_issue(repo, r):
    labels = [l["name"] if isinstance(l, dict) else l for l in (r.get("labels") or [])]
    user = r.get("user") or {}
    body = r.get("body") or ""
    return {
        "repo": repo,
        # `number` is a Malloy keyword, so the tables spell it out.
        "issue_number": r["number"],
        "title": r.get("title") or "",
        "body": body,
        "state": (r.get("state") or "").lower(),
        "author_login": user.get("login"),
        "author_id": user.get("id"),
        "author_is_bot": is_bot(user.get("login")),
        "labels": labels,
        "label_count": len(labels),
        "comment_count": r.get("comments"),
        "created_at": r.get("created_at"),
        "updated_at": r.get("updated_at"),
        "closed_at": r.get("closed_at"),
        "state_reason": r.get("state_reason"),
        "assignees": logins(r.get("assignees")),
        "milestone": (r.get("milestone") or {}).get("title"),
        "title_length": len(r.get("title") or ""),
        "body_length": len(body),
        "has_body": bool(body.strip()),
        "url": f"https://github.com/{repo}/issues/{r['number']}",
    }


def norm_pr(repo, r):
    labels = [l["name"] if isinstance(l, dict) else l for l in (r.get("labels") or [])]
    user = r.get("user") or {}
    head, base = r.get("head") or {}, r.get("base") or {}
    head_repo = (head.get("repo") or {}).get("full_name")
    body = r.get("body") or ""
    reviewers = logins(r.get("requested_reviewers"))
    return {
        "repo": repo,
        "pr_number": r["number"],
        "title": r.get("title") or "",
        "body": body,
        "state": (r.get("state") or "").lower(),
        "is_draft": bool(r.get("draft")),
        # The list endpoint leaves `merged` false even for merged PRs; the
        # merge timestamp is the field that is actually populated.
        "is_merged": bool(r.get("merged")) or bool(r.get("merged_at")),
        "author_login": user.get("login"),
        "author_id": user.get("id"),
        "author_is_bot": is_bot(user.get("login")),
        "labels": labels,
        "label_count": len(labels),
        "requested_reviewers": reviewers,
        "assignees": logins(r.get("assignees")),
        "created_at": r.get("created_at"),
        "updated_at": r.get("updated_at"),
        "closed_at": r.get("closed_at"),
        "merged_at": r.get("merged_at"),
        "base_ref": base.get("ref"),
        "base_sha": base.get("sha"),
        "head_ref": head.get("ref"),
        "head_sha": head.get("sha"),
        "head_repo": head_repo,
        "from_fork": bool(head_repo and head_repo != repo),
        "title_length": len(r.get("title") or ""),
        "body_length": len(body),
        "url": r.get("html_url") or f"https://github.com/{repo}/pull/{r['number']}",
    }


def norm_release(repo, r):
    author = r.get("author") or {}
    body = r.get("body") or ""
    tag = r.get("tag_name") or ""
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", tag)
    return {
        "repo": repo,
        "id": r.get("id"),
        "tag_name": tag,
        "name": r.get("name"),
        "body": body,
        "major": int(m.group(1)) if m else None,
        "minor": int(m.group(2)) if m else None,
        "patch": int(m.group(3)) if m else None,
        "published_at": r.get("published_at"),
        "is_prerelease": bool(r.get("prerelease")),
        "is_draft": bool(r.get("draft")),
        "author_login": author.get("login"),
        "author_is_bot": is_bot(author.get("login")),
        "body_length": len(body),
        # Release notes link every PR they shipped -- pull those out so a
        # release can be joined to the pull requests it contains.
        "pr_numbers": sorted(
            {int(n) for n in re.findall(r"/pull/(\d+)", body)}
        ),
        "url": r.get("html_url"),
    }



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    prs, releases, issue_pages = {}, {}, []
    issues, comments, review_comments, reviews = {}, {}, {}, {}
    skipped = collections.Counter()

    for name, doc in load_payloads(args.raw):
        # A page can be mixed (the REST /issues stream carries pull requests
        # too), so classify record by record rather than page by page.
        unattributed = []
        for r in records(doc):
            if not isinstance(r, dict):
                continue
            k = kind(r)
            if k == "pull_request":
                repo = repo_of_pr(r)
                if repo:
                    prs[(repo, r["number"])] = norm_pr(repo, r)
                else:
                    skipped["pull_request-no-repo"] += 1
            elif k == "release":
                repo = repo_of_release(r)
                if repo:
                    releases[(repo, r["id"])] = norm_release(repo, r)
                else:
                    skipped["release-no-repo"] += 1
            elif k == "issue":
                repo = repo_of_issue(r)
                if repo:
                    issues[(repo, r["number"])] = norm_issue(repo, r)
                else:
                    # An MCP-sourced page: no repo on the record, infer later.
                    unattributed.append(r)
            elif k == "issue_comment":
                repo, number = repo_and_number(r, "issue_url")
                if repo:
                    on_pr = "/pull/" in (r.get("html_url") or "")
                    comments[r["id"]] = norm_comment(repo, number, r, on_pr)
                else:
                    skipped["comment-no-repo"] += 1
            elif k == "review_comment":
                repo, number = repo_and_number(r, "pull_request_url")
                if repo:
                    review_comments[r["id"]] = norm_review_comment(repo, number, r)
                else:
                    skipped["review_comment-no-repo"] += 1
            elif k == "review":
                repo, number = repo_and_number(r, "pull_request_url")
                if repo:
                    reviews[r["id"]] = norm_review(repo, number, r)
                else:
                    skipped["review-no-repo"] += 1
            else:
                skipped["unclassified"] += 1
        if unattributed:
            issue_pages.append((name, unattributed))

    pr_numbers = collections.defaultdict(set)
    for repo, number in prs:
        pr_numbers[repo].add(number)

    for repo, r in attribute_issues(issue_pages, pr_numbers):
        issues[(repo, r["number"])] = norm_issue(repo, r)

    print("github api:")
    write(sorted(issues.values(), key=lambda r: (r["repo"], r["issue_number"])),
          os.path.join(args.out, "issues.parquet"))
    write(sorted(prs.values(), key=lambda r: (r["repo"], r["pr_number"])),
          os.path.join(args.out, "pull_requests.parquet"))
    write(sorted(releases.values(), key=lambda r: (r["repo"], r["published_at"] or "")),
          os.path.join(args.out, "releases.parquet"))
    # Only written when the collector actually gathered them -- the MCP
    # extraction path cannot reach these streams.
    for rows, filename, key in (
        (comments, "comments.parquet", lambda r: (r["repo"], r["number"], r["created_at"])),
        (review_comments, "review_comments.parquet",
         lambda r: (r["repo"], r["pr_number"], r["created_at"])),
        (reviews, "reviews.parquet",
         lambda r: (r["repo"], r["pr_number"], r["submitted_at"] or "")),
    ):
        if rows:
            write(sorted(rows.values(), key=key), os.path.join(args.out, filename))
    if skipped:
        print("  skipped:", dict(skipped))


if __name__ == "__main__":
    main()
