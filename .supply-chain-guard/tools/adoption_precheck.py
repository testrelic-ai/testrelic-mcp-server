"""adoption-precheck: what a consuming repository's adoption PR must change before the pinned
supply-chain-guard action can pass on day one.

    tools/adoption-precheck --repo-dir DIR [--json FILE] [--allow-draft FILE]
    tools/adoption-precheck --mirror REPO.git --refs main,stage,prod --work DIR [--json FILE]

For every tree it reports:
  1. the legacy in-repo scanner files (scripts/scan-injected-payload.sh, its test and .allow,
     scripts/supply-chain-scan.sh). The legacy scanner greps for a campaign signature as a literal,
     which is a P1 finding; P1 is never allowlistable and no path is exempt. The adoption PR deletes
     these files (or, if a repo must keep one, rewrites each literal as fragments: '_$''name').
     tools/adoption-patch makes that change. Only the exact legacy grep literal (`-e '_$<sig>'`)
     counts as "legacy": any other finding in a file of that name is reported as a real finding
     and the file is flagged as suspicious.
  2. every step that runs them (workflow steps, amplify.yml preBuild commands, package.json scripts,
     other scripts) so the PR removes or repoints them. Mentions in comments (YAML/shell `#`, JS `//`
     and JSDoc) and in documentation are listed apart: they run nothing and are not work items;
  3. the findings that remain once those files are gone, split into "fix in the PR" (not
     allowlistable) and "allowlist with a reason" (allowlistable), and optionally a draft
     .supply-chain-guard.allow whose entries are commented out until a human writes the reason.

Read-only: files are read as data, nothing from the tree is executed, hooks are disabled for the
worktrees it creates (mirror mode) and every worktree is removed afterwards.
Exit status: 0 nothing to change, 1 adoption work required, 2 could not check.
"""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))

from guard import common as C  # noqa: E402
from guard import payload as P  # noqa: E402
from guard import supply as S  # noqa: E402

LEGACY_RX = re.compile(r"(?:^|/)(?:scan-injected-" + r"payload(?:\.test)?\.sh|scan-injected-" + r"payload\.allow"
                       r"|supply-chain-" + r"scan(?:\.test)?\.sh)$")
REF_RX = re.compile(r"scan-injected-" + r"payload|supply-chain-" + r"scan\.sh")
LOCAL_COPY_CMD = "bash .supply-chain-guard/bin/scan-payload && bash .supply-chain-guard/bin/supply-chain-check"


def _kind(path):
    if path.startswith(".github/workflows/"):
        return "workflow step"
    b = path.rsplit("/", 1)[-1].lower()
    if b in ("amplify.yml", "amplify.yaml"):
        return "amplify build command"
    if b == "package.json":
        return "package.json script"
    if b in ("action.yml", "action.yaml"):
        return "action step"
    return "other reference"


# ---------------------------------------------------------------------------
# comment / documentation mentions (not steps)
# ---------------------------------------------------------------------------
DOC_EXT = frozenset(("md", "markdown", "mdx", "txt", "text", "rst", "adoc", "asciidoc", "html", "htm", "org"))
SLASH_EXT = C.JS_EXT | frozenset(("json5", "jsonc", "c", "h", "cc", "cpp", "hpp", "go", "rs", "java", "kt", "swift",
                                  "cs", "scala", "dart", "php", "css", "scss", "less"))
NO_COMMENT_EXT = frozenset(("json",))


def comment_style(path):
    """'doc' (documentation: every mention is prose), 'slash' (// and /* */), 'hash' (#: YAML,
    shell, python, Makefile, Dockerfile, extensionless scripts) or 'none' (JSON: no comments)."""
    ext = C.ext_of(path)
    if ext in DOC_EXT:
        return "doc"
    if ext in NO_COMMENT_EXT:
        return "none"
    if ext in SLASH_EXT:
        return "slash"
    return "hash"


def _comment_at(line, style):
    """Index where a comment starts on this line, or -1. Quotes before it are honoured, so
    `echo "#x"` is not a comment; an unbalanced quote means "no comment" (counted as a step)."""
    s = line.lstrip()
    lead = len(line) - len(s)
    if style == "slash" and (s.startswith("*") or s.startswith("/*")):
        return lead      # JSDoc middle line or a block comment opener
    q = None
    i, n = 0, len(line)
    while i < n:
        ch = line[i]
        if q is not None:
            if ch == "\\" and q != "'":
                i += 2
                continue
            if ch == q:
                q = None
        elif ch in "'\"" or (ch == "`" and style == "slash"):
            q = ch
        elif style == "hash" and ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return i
        elif style == "slash" and line.startswith("//", i) and (i == 0 or line[i - 1] in " \t;,{}()"):
            return i
        i += 1
    return -1


def mention_kind(path, line):
    """None when the reference on this line can run something (a step/command/script line),
    else 'documentation' or 'comment'."""
    style = comment_style(path)
    if style == "doc":
        return "documentation"
    if style == "none":
        return None
    at = _comment_at(line, style)
    if at < 0:
        return None
    if all(m.start() >= at for m in REF_RX.finditer(line)):
        return "comment"
    return None


def _fragment(sig):
    """'_$name' -> '_$''name' : the same bytes to grep -F, but no longer a literal signature."""
    return sig[:2] + "''" + sig[2:] if len(sig) > 2 else sig


def legacy_finding(f):
    """A finding that is the legacy scanner's own grep literal (and nothing else)."""
    if f.check != "P1" or not LEGACY_RX.search(f.path):
        return False
    v = f.value if isinstance(f.value, bytes) else str(f.value).encode("utf-8", "surrogateescape")
    return P.legacy_literal_only(v)


def legacy_references(repo, legacy):
    """(steps, mentions): every line outside the legacy files that names one of them."""
    steps, mentions = [], []
    for f in repo.regular:
        # the vendored guard copy documents the legacy scanner it replaces; P8 pins its bytes
        if f in legacy or f.startswith(C.GUARD_DIR + "/"):
            continue
        try:
            if os.path.getsize(repo.abspath(f)) > 4 * 1024 * 1024:
                continue
        except OSError:
            continue
        data = repo.read(f)
        if b"\0" in data[:8192]:
            continue
        text = data.decode("utf-8", "surrogateescape")
        if not REF_RX.search(text):
            continue
        for n, line in enumerate(text.split("\n"), 1):
            if REF_RX.search(line):
                mk = mention_kind(f, line.rstrip("\r"))
                d = {"path": f, "line": n, "kind": mk or _kind(f), "text": C.esc(line.strip()[:160])}
                (mentions if mk else steps).append(d)
    return steps, mentions


def check_tree(root, label):
    repo = C.Repo(root)
    legacy = [f for f in repo.regular if LEGACY_RX.search(f)]
    refs, mentions = legacy_references(repo, legacy)
    al = C.Allowlist(repo)
    allow_p4 = frozenset((e["path"], e["fp"]) for e in al.entries if e["check"] == "P4")
    findings = P.scan(repo, list(C.PAYLOAD_CHECKS), allow_p4) + S.scan(repo, list(C.SUPPLY_CHECKS), [])
    al.apply(findings)
    in_legacy, must_fix, allowable, allowlisted = [], [], [], []
    suspicious = set()
    for f in findings:
        d = {"check": f.check, "path": f.path, "line": f.line, "message": f.message, "context": f.context,
             "fingerprint": f.fingerprint, "allowlistable": f.allowlistable}
        if f.path in legacy and legacy_finding(f):
            m = re.search(r"campaign signature ([^\s;]+)", f.message)
            if m:
                d["fragment_hint"] = _fragment(m.group(1))
            in_legacy.append(d)
            continue
        if f.path in legacy:
            # not the legacy literal: a real finding in a file that only looks like the scanner
            suspicious.add(f.path)
        if f.allowed_by is not None:
            allowlisted.append(d)
        elif f.allowlistable:
            allowable.append(d)
        else:
            must_fix.append(d)
    head = ""
    try:
        head = repo.git(["rev-parse", "HEAD"]).stdout.decode().strip()
    except C.CouldNotScan:
        pass
    work = bool(legacy or refs or must_fix or allowable)
    return {"label": label, "root": root, "head": head, "legacy_files": legacy,
            "suspicious_legacy_files": sorted(suspicious), "references": refs, "mentions": mentions,
            "findings_in_legacy_files": in_legacy, "must_fix": must_fix, "allowlistable": allowable,
            "already_allowlisted": len(allowlisted), "allowlist_errors": [e[2] for e in al.errors],
            "verdict": "ADOPTION WORK REQUIRED" if work else "READY"}


def render(r):
    out = ["== %s %s" % (r["label"], r["head"][:12])]
    sus = set(r.get("suspicious_legacy_files", []))
    if r["legacy_files"]:
        out.append("legacy scanner files: delete in the adoption PR (tools/adoption-patch does it)")
        for f in r["legacy_files"]:
            hits = [d for d in r["findings_in_legacy_files"] if d["path"] == f]
            p1 = [d for d in hits if d["check"] == "P1"]
            out.append("  %s%s" % (C.esc(f), ("  [%d finding(s); P1 at line %s, not allowlistable; if the file must "
                                                "stay, write the literal as %s]" % (
                                                    len(hits), ",".join(str(d["line"]) for d in p1),
                                                    p1[0].get("fragment_hint", "fragments")) if p1 else
                                                "  [%d finding(s)]" % len(hits) if hits else "")))
            if f in sus:
                out.append("    SUSPICIOUS: this file has findings other than the legacy grep literal (listed "
                           "below); it may be a planted payload under the scanner's name: investigate before deleting")
    else:
        out.append("legacy scanner files: none")
    if r["references"]:
        out.append("steps that run the legacy scanner: remove them, or run the local copy instead (%s)"
                   % LOCAL_COPY_CMD)
        for x in r["references"]:
            out.append("  %s:%d (%s): %s" % (C.esc(x["path"]), x["line"], x["kind"], x["text"]))
    if r.get("mentions"):
        out.append("mentions in comments/docs (run nothing; not a work item, reword when convenient): %d"
                   % len(r["mentions"]))
        for x in r["mentions"]:
            out.append("  %s:%d (%s): %s" % (C.esc(x["path"]), x["line"], x["kind"], x["text"]))
    groups = {}
    for d in r["must_fix"]:
        groups.setdefault(("fix", d["check"]), []).append(d)
    for d in r["allowlistable"]:
        groups.setdefault(("allow", d["check"]), []).append(d)
    if r["must_fix"]:
        out.append("not allowlistable, fix in the adoption PR: %s" % ", ".join(
            "%s x%d" % (k[1], len(v)) for k, v in sorted(groups.items()) if k[0] == "fix"))
        for d in r["must_fix"][:40]:
            out.append("  %s %s:%d %s" % (d["check"], C.esc(d["path"]), d["line"], C.esc(d["message"][:110])))
        if len(r["must_fix"]) > 40:
            out.append("  ... %d more" % (len(r["must_fix"]) - 40))
    if r["allowlistable"]:
        out.append("allowlistable, fix or add a .supply-chain-guard.allow entry with a reason: %s" % ", ".join(
            "%s x%d" % (k[1], len(v)) for k, v in sorted(groups.items()) if k[0] == "allow"))
        for d in r["allowlistable"][:40]:
            out.append("  %s %s:%d %s" % (d["check"], C.esc(d["path"]), d["line"], C.esc(d["message"][:110])))
        if len(r["allowlistable"]) > 40:
            out.append("  ... %d more" % (len(r["allowlistable"]) - 40))
    for e in r["allowlist_errors"]:
        out.append("existing allowlist problem: %s" % C.esc(e))
    out.append("verdict: %s" % r["verdict"])
    return "\n".join(out)


def allow_draft(results):
    lines = ["# Draft generated by tools/adoption-precheck. Every entry is commented out: uncomment only",
             "# after reviewing the line, and replace <reason> with why it is legitimate. Entries without a",
             "# reason are rejected, and stale entries fail the check."]
    seen = set()
    for r in results:
        for d in r["allowlistable"]:
            k = (d["check"], d["path"], d["fingerprint"])
            if k in seen:
                continue
            seen.add(k)
            lines.append("# %s\t%s\t%s\t<reason>    (%s:%d %s)" % (d["check"], d["path"], d["fingerprint"],
                                                                   d["path"], d["line"], d["message"][:80]))
    return "\n".join(lines) + "\n"


def _git(args, cwd=None):
    env = dict(os.environ)
    env["GIT_LFS_SKIP_SMUDGE"] = "1"
    return subprocess.run(["git", "-c", "core.hooksPath=/dev/null"] + args, cwd=cwd, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def mirror_trees(mirror, refs, work):
    """Yield (label, worktree_dir or None, note) for each ref; removes each worktree after use."""
    name = os.path.basename(mirror.rstrip("/"))
    if name.endswith(".git"):
        name = name[:-4]
    for ref in refs:
        p = _git(["-C", mirror, "rev-parse", "-q", "--verify", "refs/heads/%s^{commit}" % ref])
        sha = p.stdout.decode().strip()
        if p.returncode != 0 or not sha:
            yield "%s %s" % (name, ref), None, "no branch %s in %s" % (ref, mirror)
            continue
        wt = os.path.join(work, "precheck-%s-%s-%s" % (name, ref.replace("/", "_"), sha[:12]))
        if os.path.exists(wt):
            _git(["-C", mirror, "worktree", "remove", "--force", wt])
            shutil.rmtree(wt, ignore_errors=True)
            _git(["-C", mirror, "worktree", "prune"])
        p = _git(["-C", mirror, "worktree", "add", "-q", "--detach", wt, sha])
        if p.returncode != 0:
            yield "%s %s" % (name, ref), None, "cannot check out %s: %s" % (ref, p.stderr.decode()[:200])
            continue
        try:
            yield "%s %s" % (name, ref), wt, ""
        finally:
            _git(["-C", mirror, "worktree", "remove", "--force", wt])
            shutil.rmtree(wt, ignore_errors=True)
            _git(["-C", mirror, "worktree", "prune"])


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="adoption-precheck")
    ap.add_argument("--repo-dir")
    ap.add_argument("--mirror")
    ap.add_argument("--refs", default="main,stage,prod")
    ap.add_argument("--work", help="directory for temporary worktrees (mirror mode)")
    ap.add_argument("--json")
    ap.add_argument("--allow-draft")
    a = ap.parse_args(argv)
    if bool(a.repo_dir) == bool(a.mirror):
        print("adoption-precheck: COULD NOT CHECK: give exactly one of --repo-dir or --mirror")
        return 2
    results, rc = [], 0
    try:
        probs = P.run_canary(list(C.PAYLOAD_CHECKS)) + S.run_canary(list(C.SUPPLY_CHECKS))
        if probs:
            raise C.CouldNotScan("built-in canary failed: " + "; ".join(probs))
        if a.repo_dir:
            trees = [(os.path.basename(os.path.abspath(a.repo_dir)), a.repo_dir, "")]
        else:
            if not a.work or not os.path.isdir(a.work):
                raise C.CouldNotScan("--mirror needs --work DIR (an existing directory for temporary worktrees)")
            trees = mirror_trees(a.mirror, [r.strip() for r in a.refs.split(",") if r.strip()], a.work)
        try:
            for label, root, note in trees:
                if root is None:
                    print("== %s\nskipped: %s\n" % (label, C.esc(note)))
                    results.append({"label": label, "skipped": note})
                    continue
                r = check_tree(root, label)
                results.append(r)
                print(render(r) + "\n")
                if r["verdict"] != "READY":
                    rc = max(rc, 1)
        finally:
            if hasattr(trees, "close"):
                trees.close()   # removes the current temporary worktree even on error
    except C.CouldNotScan as e:
        print("adoption-precheck: COULD NOT CHECK: %s" % e)
        return 2
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(results, fh, indent=1, sort_keys=True)
    if a.allow_draft:
        with open(a.allow_draft, "w") as fh:
            fh.write(allow_draft([r for r in results if "skipped" not in r]))
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:  # never a silent pass
        print("adoption-precheck: COULD NOT CHECK: internal error %s: %s" % (type(e).__name__, C.esc(str(e))[:300]))
        sys.exit(2)
