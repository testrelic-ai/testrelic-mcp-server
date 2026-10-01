"""adoption-patch: make a consuming repository's adoption change in its working tree, then verify it.

    tools/adoption-patch --repo-dir DIR [--patch FILE] [--json FILE]
    tools/adoption-patch --mirror REPO.git --refs main,stage,prod --work DIR --out DIR [--json FILE]

The legacy in-repo scanner (scripts/scan-injected-payload.sh) greps for campaign signatures as
literal `-e '<sig>'` arguments, so the pinned guard reports it as P1. P1 is never allowlistable and
no path is exempt (an exempt name is where the next wave would hide), so the adoption PR has to
remove the literal. This tool makes exactly that change:

  1. delete the legacy scanner files (scripts/scan-injected-payload.sh, its .test.sh and .allow,
     scripts/supply-chain-scan.sh and its .test.sh);
  2. repoint every step that ran them at the guard's local copy, keeping the step itself (its
     name, its job, every `needs:` on it): in workflows, action.yml, amplify.yml, package.json
     scripts, shell scripts, Makefiles and Dockerfiles,
        bash scripts/scan-injected-payload.sh       -> bash .supply-chain-guard/bin/scan-payload &&
                                                       bash .supply-chain-guard/bin/supply-chain-check
        bash scripts/scan-injected-payload.test.sh  -> bash .supply-chain-guard/bin/self-test
  3. vendor the local copy at .supply-chain-guard/ from this toolkit, byte for byte, so P8 in the
     pinned action passes and keeps failing any later edit of the copy.

It leaves comments and documentation alone (they are listed). It changes nothing it cannot
change safely: an invocation with arguments, inside a pipe, `||` or `$(...)`, from JS/TS code, or
a bare path (a path filter, a copy) is listed for a human. A file that has a legacy scanner's name
but carries any finding other than the legacy grep literal is NOT deleted: it may be a planted
payload, so it is reported as SUSPICIOUS. Afterwards the tree is scanned again (adoption-precheck),
so the report shows whether P1 is gone and what else still blocks.

The working tree must be clean. The change is written and staged there (never committed), so run
it on a fresh branch or a scratch worktree; --patch also writes it as a `git apply` patch. Mirror
mode does the same on temporary detached worktrees of main/stage/prod and writes one patch and one
report per head into --out. Nothing from the tree is executed; git runs with hooks disabled.
Exit status: 0 the patched tree passes the guard, 1 the change was made but work remains (or a
reference needs a human, or a legacy-named file is suspicious), 2 could not run.
"""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
sys.path.insert(0, HERE)

from guard import common as C  # noqa: E402
from guard import payload as P  # noqa: E402
from guard import supply as S  # noqa: E402
import adoption_precheck as A  # noqa: E402

LOCAL = C.GUARD_DIR
SCAN_CMD = "bash {p}" + LOCAL + "/bin/scan-payload && bash {p}" + LOCAL + "/bin/supply-chain-check"
SELFTEST_CMD = "bash {p}" + LOCAL + "/bin/self-test"

# files whose lines reach a shell as written
REWRITE_EXT = frozenset(("yml", "yaml", "sh", "bash", "zsh", "ksh"))
REWRITE_BASES = frozenset(("package.json", "Makefile", "makefile", "GNUmakefile", "Dockerfile"))
_NAMES = r"scan-injected-" r"payload(?:\.test)?\.sh|supply-chain-" r"scan(?:\.test)?\.sh"
INVOKE_RX = re.compile(r"(?<![\w./-])(?P<sh>(?:ba|da|z|k)?sh[ \t]+)?(?P<dot>\./)?(?P<dir>(?:[\w.@+-]+/)*)"
                       r"(?P<name>" + _NAMES + r")(?=[ \t]*(?:$|&&|;|\)|\"|'|#))")
# what may precede a direct `./scripts/x.sh` for it to be a command (not a path in a list)
_DIRECT_AFTER = ("run:", "&&", ";", '"', "'")
_CLIMB = re.compile(r"(?:\.\./)*\Z")


def _rewritable(path):
    base = path.rsplit("/", 1)[-1]
    return C.ext_of(path) in REWRITE_EXT or base in REWRITE_BASES or base.startswith("Dockerfile")


def _git(repo, args, ok=(0,)):
    return C.run_git(["-c", "core.hooksPath=/dev/null"] + args, cwd=repo.root, env=repo.env, ok=ok)


def _is_clean(repo):
    p = _git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])
    return not p.stdout.strip(b"\0").strip()


def toolkit_files():
    """The files of this toolkit, as the pinned action checkout has them (git ls-files when the
    toolkit is a git checkout, else the same walk P8 uses)."""
    root = C.GUARD_ROOT
    try:
        p = subprocess.run(["git", "-C", root, "ls-files", "-z"], env=C.tool_env(), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE)
        top = subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"], env=C.tool_env(),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise C.CouldNotScan("cannot run git: %s" % e)
    files, sha, dirty = [], "", False
    if p.returncode == 0 and p.stdout.strip(b"\0") and \
            os.path.realpath(top.stdout.decode("utf-8", "surrogateescape").strip()) == os.path.realpath(root):
        files = [x.decode("utf-8", "surrogateescape") for x in p.stdout.split(b"\0") if x]
        files = [f for f in files if os.path.isfile(os.path.join(root, f))]
        q = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], env=C.tool_env(), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE)
        sha = q.stdout.decode().strip() if q.returncode == 0 else ""
        d = subprocess.run(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"], env=C.tool_env(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        dirty = bool(d.stdout.strip())
    else:
        files = sorted(P._own_files())
    for need in ("action.yml", "bin/scan-payload", "bin/supply-chain-check", "bin/self-test", "lib/guard/main.py"):
        if need not in files:
            raise C.CouldNotScan("toolkit at %s has no %s; cannot vendor a local copy" % (C.esc(root), need))
    return files, sha, dirty


def _comment_cut(path, line):
    style = A.comment_style(path)
    if style in ("doc", "none"):
        return -1
    return A._comment_at(line, style)


def plan_line(path, line, deleted):
    """-> (new_line or None, [(old, new)], [manual reasons]) for one line that names a legacy file."""
    cut = _comment_cut(path, line)
    code = line if cut < 0 else line[:cut]
    manual, edits = [], []
    if not A.REF_RX.search(code):
        return None, [], []            # only in a comment: a mention
    if not _rewritable(path):
        return None, [], ["%s is not a shell/YAML/package.json file; rewrite this reference by hand" % path]
    spans = []
    for m in INVOKE_RX.finditer(code):
        if not m.group("sh"):
            before = code[:m.start()].strip()
            if not m.group("dot") or not (before in ("", "-") or before.endswith(_DIRECT_AFTER)):
                continue                    # a bare path (path filter, cp argument): not a command
        spans.append(m)
    covered = set()
    for m in spans:
        covered.update(range(m.start(), m.end()))
    for r in A.REF_RX.finditer(code):
        if r.start() not in covered:
            manual.append("names a legacy scanner outside a plain `bash <script>` command")
            break
    if not spans or manual:
        return None, [], manual or ["no plain `bash <script>` invocation to rewrite"]
    if "|" in code.replace("run: |", "").replace("run: >", "") or "$(" in code or "`" in code:
        return None, [], ["invocation inside a pipe, `||`, `$(...)` or backticks; rewrite by hand"]
    out, last = [], 0
    for m in spans:
        name = m.group("name")
        rd = m.group("dir")                 # e.g. "scripts/", "../../scripts/"
        # the command's working directory reaches the repository root through `../` only; the
        # rest of the path must be where the deleted legacy file lived
        prefixes = set()
        for d in deleted:
            if d.rsplit("/", 1)[-1] != name:
                continue
            ddir = d[:len(d) - len(name)]
            if rd.endswith(ddir) and _CLIMB.match(rd[:len(rd) - len(ddir)]):
                prefixes.add(rd[:len(rd) - len(ddir)])
        if len(prefixes) != 1:
            return None, [], ["`%s` does not resolve to exactly one deleted legacy file" % C.esc(m.group(0).strip())]
        cmd = SELFTEST_CMD if ".test." in name else SCAN_CMD
        new = cmd.format(p=prefixes.pop())
        out.append(code[last:m.start()])
        out.append(new)
        edits.append((m.group(0).strip(), new))
        last = m.end()
    out.append(line[last:])
    return "".join(out), edits, []


def patch_tree(root, label, patch_path=None):
    repo = C.Repo(root)
    if not _is_clean(repo):
        raise C.CouldNotScan("%s has uncommitted changes to tracked files; run on a clean checkout" % C.esc(repo.root))
    res = {"label": label, "root": repo.root, "deleted": [], "suspicious": [], "rewritten": [], "manual": [],
           "mentions": 0, "vendored": 0, "toolkit_sha": "", "toolkit_dirty": False}
    try:
        res["head"] = _git(repo, ["rev-parse", "HEAD"]).stdout.decode().strip()
    except C.CouldNotScan:
        res["head"] = ""
    legacy = [f for f in repo.regular if A.LEGACY_RX.search(f)]
    before = P.scan(repo, list(C.PAYLOAD_CHECKS)) if legacy else []
    for f in legacy:
        bad = [x for x in before if x.path == f and not A.legacy_finding(x)]
        if bad:
            res["suspicious"].append({"path": f, "findings": ["%s line %d: %s" % (x.check, x.line, x.message[:100])
                                                              for x in bad[:5]]})
        else:
            res["deleted"].append(f)
    deleted = res["deleted"]

    edited = {}
    steps, mentions = A.legacy_references(repo, legacy)
    res["mentions"] = len(mentions)
    by_file = {}
    for s in steps:
        by_file.setdefault(s["path"], []).append(s["line"])
    for path, linenos in sorted(by_file.items()):
        raw = repo.read(path)
        text = raw.decode("utf-8", "surrogateescape")
        lines = text.split("\n")
        changed = False
        for n in linenos:
            line = lines[n - 1]
            cr = line.endswith("\r")
            body = line[:-1] if cr else line
            new, edits, manual = plan_line(path, body, deleted)
            for why in manual:
                res["manual"].append({"path": path, "line": n, "why": why, "text": C.esc(body.strip()[:160])})
            if new is not None and edits:
                lines[n - 1] = new + ("\r" if cr else "")
                changed = True
                for old, nw in edits:
                    res["rewritten"].append({"path": path, "line": n, "old": C.esc(old), "new": C.esc(nw)})
        if changed:
            data = "\n".join(lines).encode("utf-8", "surrogateescape")
            if path.rsplit("/", 1)[-1] == "package.json":
                try:
                    json.loads(data.decode("utf-8-sig"))
                except (ValueError, UnicodeDecodeError):
                    res["rewritten"] = [r for r in res["rewritten"] if r["path"] != path]
                    res["manual"].append({"path": path, "line": linenos[0], "why": "rewrite would break the JSON",
                                          "text": ""})
                    continue
            edited[path] = data

    # everything that can fail is checked before the first write
    files = []
    if res["rewritten"]:
        files, res["toolkit_sha"], res["toolkit_dirty"] = toolkit_files()
    # write: deletions, edits, local copy
    for f in deleted:
        os.remove(repo.abspath(f))
    for path, data in edited.items():
        with open(repo.abspath(path), "wb") as fh:
            fh.write(data)
    if res["rewritten"]:
        # .supply-chain-guard/ belongs to the guard (P8 rejects any file there that the pinned action
        # lacks), so an older copy, and any untracked leftover in it, is replaced wholesale
        old_copy = [f for f in repo.files if f == LOCAL or f.startswith(LOCAL + "/")]
        here = os.path.join(repo.root, LOCAL)
        if os.path.islink(here) or os.path.isfile(here):
            os.remove(here)
        elif os.path.isdir(here):
            shutil.rmtree(here)
        if old_copy:
            _git(repo, ["rm", "-q", "-r", "--cached", "--ignore-unmatch", "--", LOCAL])
        for rel in files:
            src = os.path.join(C.GUARD_ROOT, rel)
            dst = os.path.join(repo.root, LOCAL, rel)
            if not os.path.isdir(os.path.dirname(dst)):
                os.makedirs(os.path.dirname(dst))
            shutil.copyfile(src, dst)
            os.chmod(dst, 0o700 if os.stat(src).st_mode & 0o111 else 0o600)  # git keeps only the exec bit
        res["vendored"] = len(files)
    if deleted:
        _git(repo, ["rm", "-q", "--cached", "--ignore-unmatch", "--"] + deleted)
    if edited:
        _git(repo, ["add", "--"] + sorted(edited))
    if res["vendored"]:
        _git(repo, ["add", "-f", "-A", "--", LOCAL])
    if patch_path:
        p = _git(repo, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--full-index"])
        with open(patch_path, "wb") as fh:
            fh.write(p.stdout)
        res["patch"] = patch_path
        res["patch_bytes"] = len(p.stdout)
    post = A.check_tree(repo.root, label)
    res["after"] = post
    res["p1_after"] = [d for d in post["must_fix"] + post["findings_in_legacy_files"] if d["check"] == "P1"]
    ok = (post["verdict"] == "READY" and not res["manual"] and not res["suspicious"])
    res["verdict"] = "READY" if ok else "WORK REMAINS"
    return res


def render(r):
    out = ["== %s %s" % (r["label"], r.get("head", "")[:12])]
    out.append("deleted (legacy scanner): %s" % (", ".join(C.esc(f) for f in r["deleted"]) or "none"))
    for s in r["suspicious"]:
        out.append("SUSPICIOUS, kept for a human: %s has findings other than the legacy grep literal: %s"
                   % (C.esc(s["path"]), "; ".join(C.esc(x) for x in s["findings"])))
    if r["rewritten"]:
        out.append("repointed to the local copy (%d):" % len(r["rewritten"]))
        for x in r["rewritten"]:
            out.append("  %s:%d: %s -> %s" % (C.esc(x["path"]), x["line"], x["old"], x["new"]))
    if r["vendored"]:
        out.append("vendored %s/ (%d files) from supply-chain-guard %s%s; pin the action to that commit" % (
            LOCAL, r["vendored"], r["toolkit_sha"][:12] or "(not a git checkout)",
            " [toolkit tree has uncommitted changes: P8 will fail against the pinned commit]"
            if r["toolkit_dirty"] else ""))
    if r["mentions"]:
        out.append("left as is: %d mention(s) in comments/docs" % r["mentions"])
    for x in r["manual"]:
        out.append("needs a human: %s:%d: %s | %s" % (C.esc(x["path"]), x["line"], x["why"], x["text"]))
    if r.get("patch"):
        out.append("patch: %s (%d bytes)" % (C.esc(r["patch"]), r["patch_bytes"]))
    out.append("P1 after the change: %d" % len(r["p1_after"]))
    out.append("-- adoption-precheck of the changed tree --")
    out.append(A.render(r["after"]))
    out.append("adoption-patch verdict: %s" % r["verdict"])
    return "\n".join(out)


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="adoption-patch")
    ap.add_argument("--repo-dir")
    ap.add_argument("--patch")
    ap.add_argument("--mirror")
    ap.add_argument("--refs", default="main,stage,prod")
    ap.add_argument("--work")
    ap.add_argument("--out")
    ap.add_argument("--json")
    a = ap.parse_args(argv)
    if bool(a.repo_dir) == bool(a.mirror):
        print("adoption-patch: COULD NOT RUN: give exactly one of --repo-dir or --mirror")
        return 2
    results, rc = [], 0
    try:
        probs = P.run_canary(list(C.PAYLOAD_CHECKS)) + S.run_canary(list(C.SUPPLY_CHECKS))
        if probs:
            raise C.CouldNotScan("built-in canary failed: " + "; ".join(probs))
        if a.repo_dir:
            r = patch_tree(a.repo_dir, os.path.basename(os.path.abspath(a.repo_dir)), a.patch)
            results.append(r)
            print(render(r) + "\n")
            rc = 0 if r["verdict"] == "READY" else 1
        else:
            if not a.work or not os.path.isdir(a.work) or not a.out or not os.path.isdir(a.out):
                raise C.CouldNotScan("--mirror needs --work DIR and --out DIR (existing directories)")
            trees = A.mirror_trees(a.mirror, [x.strip() for x in a.refs.split(",") if x.strip()], a.work)
            try:
                for label, root, note in trees:
                    if root is None:
                        print("== %s\nskipped: %s\n" % (label, C.esc(note)))
                        results.append({"label": label, "skipped": note})
                        continue
                    stem = os.path.join(a.out, label.replace(" ", "-").replace("/", "_"))
                    r = patch_tree(root, label, stem + ".patch")
                    results.append(r)
                    text = render(r)
                    with open(stem + ".txt", "w") as fh:
                        fh.write(text + "\n")
                    print(text + "\n")
                    if r["verdict"] != "READY":
                        rc = max(rc, 1)
            finally:
                trees.close()
    except C.CouldNotScan as e:
        print("adoption-patch: COULD NOT RUN: %s" % e)
        return 2
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(results, fh, indent=1, sort_keys=True)
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:  # never a silent pass
        print("adoption-patch: COULD NOT RUN: internal error %s: %s" % (type(e).__name__, C.esc(str(e))[:300]))
        sys.exit(2)
