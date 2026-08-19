#!/usr/bin/env python3
"""Collect a repo's GitHub API history into raw/ as one JSON file per page.

Everything here uses repo-wide list endpoints, so the whole conversation
history costs a few hundred requests rather than one per issue:

  issues            /issues?state=all      (pull requests come back too; the
                                            loader splits them by shape)
  pulls             /pulls?state=all
  issue_comments    /issues/comments       every comment on every issue AND
                                            pull request, in one stream
  review_comments   /pulls/comments        every inline review comment
  releases          /releases
  labels            /labels
  contributors      /contributors

Pull-request *reviews* (approve / request-changes, without the inline
comments) have no repo-wide endpoint, so `--with-reviews` walks the pull
requests one at a time. That is the expensive one; leave it off unless you
want it.

    GITHUB_TOKEN=ghp_... python3 github_api.py \\
        --repo malloydata/malloy --repo malloydata/malloyyo --out ../raw

A token is optional for public repos but raises the rate limit from 60 to
5000 requests an hour; the script waits out a limit rather than failing.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"

# The repo-wide streams, in the order they are fetched.
STREAMS = [
    ("issues", "/repos/{repo}/issues", {"state": "all", "sort": "created", "direction": "asc"}),
    ("pulls", "/repos/{repo}/pulls", {"state": "all", "sort": "created", "direction": "asc"}),
    ("issue_comments", "/repos/{repo}/issues/comments", {"sort": "created", "direction": "asc"}),
    ("review_comments", "/repos/{repo}/pulls/comments", {"sort": "created", "direction": "asc"}),
    ("releases", "/repos/{repo}/releases", {}),
    ("labels", "/repos/{repo}/labels", {}),
    ("contributors", "/repos/{repo}/contributors", {"anon": "1"}),
]


def request(url, token, retries=5):
    """One GET, with rate-limit and transient-error handling."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "malloy-github-history",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=60
            ) as resp:
                return json.loads(resp.read().decode()), dict(resp.headers)
        except urllib.error.HTTPError as e:
            hdrs = dict(e.headers or {})
            if e.code in (403, 429) and hdrs.get("X-RateLimit-Remaining") == "0":
                wait = max(int(hdrs.get("X-RateLimit-Reset", 0)) - int(time.time()), 1) + 2
                print(f"  rate limited, sleeping {wait}s", flush=True)
                time.sleep(wait)
                continue
            if e.code >= 500 and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"gave up on {url}")


def next_link(headers):
    for part in (headers.get("Link") or "").split(","):
        m = re.match(r'\s*<([^>]+)>;\s*rel="next"', part)
        if m:
            return m.group(1)
    return None


def paginate(path, params, token):
    """Yield each page of a list endpoint."""
    query = "&".join(f"{k}={v}" for k, v in {**params, "per_page": 100}.items())
    url = f"{API}{path}?{query}"
    while url:
        page, headers = request(url, token)
        if not page:
            return
        yield page
        url = next_link(headers)


def dump(out, repo, stream, index, page):
    name = f"{repo.replace('/', '__')}__{stream}__{index:04d}.json"
    with open(os.path.join(out, name), "w") as fh:
        json.dump(page, fh)
    return len(page)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, action="append", metavar="owner/name")
    ap.add_argument("--out", required=True, help="raw payload directory")
    ap.add_argument(
        "--with-reviews",
        action="store_true",
        help="also walk every pull request for its reviews (one request per PR)",
    )
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("no GITHUB_TOKEN set -- running unauthenticated (60 req/hour)", file=sys.stderr)

    for repo in args.repo:
        print(repo)
        for stream, path, params in STREAMS:
            total = 0
            for i, page in enumerate(paginate(path.format(repo=repo), params, token)):
                total += dump(args.out, repo, stream, i, page)
            print(f"  {stream:16} {total:>6,}")

        if args.with_reviews:
            numbers = []
            for page in paginate(f"/repos/{repo}/pulls", {"state": "all"}, token):
                numbers += [r["number"] for r in page]
            total = 0
            for n in numbers:
                reviews, _ = request(
                    f"{API}/repos/{repo}/pulls/{n}/reviews?per_page=100", token
                )
                if reviews:
                    total += dump(args.out, repo, f"reviews__pr{n}", 0, reviews)
            print(f"  {'reviews':16} {total:>6,} (over {len(numbers):,} pull requests)")


if __name__ == "__main__":
    main()
