#!/usr/bin/env python3
"""Extract a repo's full git history into parquet.

Reads a local clone (must be a full clone -- `git fetch --unshallow` first) and
writes three tables:

  commits.parquet       one row per commit, with the diffstat rolled up
  commit_files.parquet  one row per (commit, file touched)
  tags.parquet          one row per tag, with the release-ish metadata git has

Nothing here touches the GitHub API, so it works on any clone.
"""
import argparse
import os
import re
import subprocess
import sys

from common import write

# Record/field separators picked so they cannot show up in a commit message.
REC, FLD, END = "\x01", "\x1f", "\x1e"
FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%T", "%s", "%B"]
PRETTY = REC + FLD.join(FIELDS) + END

# `fix(persist): a persisted sql_select reads its built table (#3040)`
PR_RE = re.compile(r"\(#(\d+)\)\s*$")
# ...and the merge-commit form GitHub writes for non-squash merges.
MERGE_PR_RE = re.compile(r"^Merge pull request #(\d+) ")
CONVENTIONAL_RE = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!?):\s")
COAUTHOR_RE = re.compile(r"^Co-authored-by:\s*(.+?)\s*<(.+?)>\s*$", re.I | re.M)
SIGNOFF_RE = re.compile(r"^Signed-off-by:\s*(.+?)\s*<(.+?)>\s*$", re.I | re.M)
# numstat renders renames as `dir/{old => new}/f.ts` or `old.ts => new.ts`
RENAME_BRACED_RE = re.compile(r"^(.*)\{(.*) => (.*)\}(.*)$")

TEST_HINTS = ("test", "tests", "spec", "__tests__", "e2e")
DOC_EXTS = {".md", ".mdx", ".rst", ".txt", ".adoc"}


def run(repo, *args):
    out = subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, check=True
    ).stdout
    return out.decode("utf-8", errors="replace")


def classify_path(path):
    """Split a path into the columns a semantic model wants to group by."""
    parts = path.split("/")
    top = parts[0] if len(parts) > 1 else ""
    directory = "/".join(parts[:-1])
    base = parts[-1]
    ext = os.path.splitext(base)[1].lower()
    lowered = path.lower()
    is_test = any(seg.lower() in TEST_HINTS for seg in parts[:-1]) or bool(
        re.search(r"\.(test|spec)\.[a-z]+$", base, re.I)
    )
    is_docs = ext in DOC_EXTS or lowered.startswith("docs/") or "/docs/" in lowered
    return top, directory, base, ext, is_test, is_docs


def resolve_rename(path):
    """numstat rename syntax -> (old_path, new_path)."""
    m = RENAME_BRACED_RE.match(path)
    if m:
        prefix, old, new, suffix = m.groups()
        clean = lambda s: re.sub(r"//+", "/", f"{prefix}{s}{suffix}")
        return clean(old), clean(new)
    if " => " in path:
        old, new = path.split(" => ", 1)
        return old, new
    return None, path


def main_branch_shas(repo):
    """SHAs on the default branch, so analysis can exclude unmerged side work."""
    for ref in ("origin/main", "origin/master", "HEAD"):
        try:
            out = run(repo, "rev-list", ref)
        except subprocess.CalledProcessError:
            continue
        return set(out.split()), ref
    return set(), ""


def extract_tags(repo, repo_name):
    fmt = FLD.join(
        [
            "%(refname:short)",
            "%(objecttype)",
            "%(objectname)",
            "%(*objectname)",
            "%(creatordate:iso-strict)",
            "%(creator)",
            "%(taggeremail)",
            "%(subject)",
        ]
    )
    rows = []
    for line in run(repo, "for-each-ref", "--format=" + fmt, "refs/tags").splitlines():
        if not line.strip():
            continue
        name, objtype, obj, peeled, date, creator, email, subject = (
            line.split(FLD) + [""] * 8
        )[:8]
        # %(creator) is "Name <email> timestamp tz" -- keep just the name part
        who = creator.split(" <")[0]
        email = (email or (creator.split("<", 1)[1].split(">")[0] if "<" in creator else ""))
        rows.append(
            {
                "repo": repo_name,
                "tag": name,
                "sha": peeled or obj,
                "is_annotated": objtype == "tag",
                "tagged_at": date or None,
                "tagger_name": who,
                "tagger_email": email.strip("<>"),
                "subject": subject,
                # `v0.0.99` / `malloyyo-v0.2.31` -> the version part
                "version": (
                    re.search(r"(\d+\.\d+\.\d+.*)$", name).group(1)
                    if re.search(r"(\d+\.\d+\.\d+.*)$", name)
                    else None
                ),
            }
        )
    return rows


def extract_commits(repo, repo_name, on_main, main_ref):
    raw = run(
        repo,
        "log",
        "--all",
        "--numstat",
        "--date=iso-strict",
        "--pretty=format:" + PRETTY,
    )
    commits, files, seen = [], [], set()
    for chunk in raw.split(REC):
        if not chunk.strip():
            continue
        header, _, stat_block = chunk.partition(END)
        parts = header.split(FLD)
        if len(parts) < len(FIELDS):
            continue
        (sha, short, parents, an, ae, adate, cn, ce, cdate, tree, subject, body) = parts[
            : len(FIELDS)
        ]
        if sha in seen:
            continue
        seen.add(sha)

        parent_list = parents.split() if parents.strip() else []
        pr = PR_RE.search(subject) or MERGE_PR_RE.match(subject)
        conv = CONVENTIONAL_RE.match(subject)

        insertions = deletions = 0
        binary_files = 0
        for line in stat_block.splitlines():
            if not line.strip():
                continue
            cols = line.split("\t")
            if len(cols) != 3:
                continue
            add, dele, path = cols
            is_binary = add == "-" or dele == "-"
            add_n = 0 if is_binary else int(add)
            del_n = 0 if is_binary else int(dele)
            insertions += add_n
            deletions += del_n
            binary_files += int(is_binary)
            old_path, new_path = resolve_rename(path)
            top, directory, base, ext, is_test, is_docs = classify_path(new_path)
            files.append(
                {
                    "repo": repo_name,
                    "sha": sha,
                    "path": new_path,
                    "old_path": old_path,
                    "is_rename": old_path is not None,
                    "top_dir": top,
                    "directory": directory,
                    "file_name": base,
                    "extension": ext,
                    "is_test": is_test,
                    "is_docs": is_docs,
                    "insertions": add_n,
                    "deletions": del_n,
                    "is_binary": is_binary,
                    "authored_at": adate,
                    "author_email": ae.lower(),
                }
            )

        coauthors = COAUTHOR_RE.findall(body)
        commits.append(
            {
                "repo": repo_name,
                "sha": sha,
                "short_sha": short,
                "tree": tree,
                "parents": parent_list,
                "parent_count": len(parent_list),
                "is_merge": len(parent_list) > 1,
                "is_root": not parent_list,
                "on_default_branch": sha in on_main,
                "default_branch_ref": main_ref,
                "author_name": an,
                "author_email": ae.lower(),
                "authored_at": adate,
                "committer_name": cn,
                "committer_email": ce.lower(),
                "committed_at": cdate,
                "subject": subject,
                "body": body[len(subject) :].strip(),
                "message_lines": len([l for l in body.splitlines() if l.strip()]),
                "pr_number": int(pr.group(1)) if pr else None,
                "commit_type": conv.group("type") if conv else None,
                "commit_scope": (conv.group("scope") or None) if conv else None,
                "is_breaking": bool(conv and conv.group("bang"))
                or "BREAKING CHANGE" in body,
                "coauthor_count": len(coauthors),
                "coauthor_emails": [e.lower() for _, e in coauthors],
                "is_claude_assisted": any(
                    "claude" in n.lower() or "claude" in e.lower()
                    for n, e in coauthors
                ),
                "signed_off_by": [e.lower() for _, e in SIGNOFF_RE.findall(body)],
                "files_changed": None,  # filled in below from the file rows
                "insertions": insertions,
                "deletions": deletions,
                "net_lines": insertions - deletions,
                "binary_files": binary_files,
            }
        )

    counts = {}
    for f in files:
        counts[f["sha"]] = counts.get(f["sha"], 0) + 1
    for c in commits:
        c["files_changed"] = counts.get(c["sha"], 0)
    return commits, files



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--repo",
        required=True,
        action="append",
        metavar="PATH=owner/name",
        help="a full local clone and the repo name to stamp on its rows; "
        "repeat for each repo -- all of them land in one set of tables",
    )
    ap.add_argument("--out", required=True, help="output directory")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    all_commits, all_files, all_tags = [], [], []
    for spec in args.repo:
        path, _, name = spec.partition("=")
        if not name:
            sys.exit(f"--repo needs PATH=owner/name, got {spec!r}")
        if os.path.exists(os.path.join(path, ".git", "shallow")):
            sys.exit(f"{path} is a shallow clone; run `git fetch --unshallow` first")

        on_main, main_ref = main_branch_shas(path)
        commits, files = extract_commits(path, name, on_main, main_ref)
        all_commits += commits
        all_files += files
        all_tags += extract_tags(path, name)
        print(f"{name}: {len(commits):,} commits, {len(files):,} file changes")

    print("git history:")
    write(all_commits, os.path.join(args.out, "commits.parquet"))
    write(all_files, os.path.join(args.out, "commit_files.parquet"))
    write(all_tags, os.path.join(args.out, "tags.parquet"))


if __name__ == "__main__":
    main()
