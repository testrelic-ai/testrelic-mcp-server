"""commit-provenance: C1-C3 for a PR range (base..head) or a push (before..after, forced).

Reads commit objects with git cat-file; signature verification asks the GitHub REST API
(GET /repos/{o}/{r}/commits/{sha}, read-only, via curl). Any lookup that fails is a
"could not scan", never a pass.
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile

from . import common as C
from .common import Finding

ZERO = "0" * 40
_RX_SHA = re.compile(r"\A[0-9a-f]{40}\Z")
_RX_MERGE_SUBJ = re.compile(r"^(Merge pull request|Merge branch|Merge remote-tracking)")
_RX_PROTECTED = re.compile(r"\Arefs/heads/(main|stage|prod|release/.+)\Z")
_RX_IDENT = re.compile(r"\A(.*) <([^>]*)> (-?\d+) ([+-]\d{4})\Z")
MAX_COMMITS = 5000


class Commit(object):
    def __init__(self, sha, tree, parents, author, committer, signed, message):
        self.sha, self.tree, self.parents = sha, tree, parents
        self.author, self.committer = author, committer   # (name, email, epoch:int, tz:str) or ISO date
        self.signed, self.message = signed, message

    @property
    def subject(self):
        return self.message.split("\n", 1)[0]


def _ident(raw):
    m = _RX_IDENT.match(raw)
    if not m:
        return (raw, "", 0, "+0000")
    return (m.group(1), m.group(2), int(m.group(3)), m.group(4))


def read_commit(repo, sha):
    p = repo.git(["cat-file", "commit", sha], ok=(0, 128))
    if p.returncode != 0:
        return None
    raw = p.stdout
    head, _, msg = raw.partition(b"\n\n")
    tree, parents, signed = None, [], False
    author = committer = ("", "", 0, "+0000")
    for line in head.split(b"\n"):
        if line.startswith(b" "):
            continue
        k, _, v = line.partition(b" ")
        v = v.decode("utf-8", "surrogateescape")
        if k == b"tree":
            tree = v
        elif k == b"parent":
            parents.append(v)
        elif k == b"author":
            author = _ident(v)
        elif k == b"committer":
            committer = _ident(v)
        elif k in (b"gpgsig", b"gpgsig-sha256"):
            signed = True
    return Commit(sha, tree, parents, author, committer, signed, msg.decode("utf-8", "surrogateescape"))


def needs_github_signature(c):
    an, ae = c.author[0], c.author[1]
    cn, ce = c.committer[0], c.committer[1]
    if cn == "GitHub" and ce == "noreply@github.com":
        return "committer is GitHub <noreply@github.com>"
    for who, n, e in (("author", an, ae), ("committer", cn, ce)):
        if n.endswith("[bot]") or e.endswith("[bot]@users.noreply.github.com"):
            return "%s is a bot (%s)" % (who, C.esc(n))
    return None


class Api(object):
    def __init__(self, repo_slug, base=None, token=None):
        self.slug = repo_slug
        self.base = (base or os.environ.get("GUARD_GITHUB_API") or os.environ.get("GITHUB_API_URL")
                     or "https://api.github.com").rstrip("/")
        self.token = token if token is not None else (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "")
        self.cache = {}

    def commit(self, sha):
        if sha in self.cache:
            return self.cache[sha]
        if not self.slug or not re.match(r"\A[\w.-]+/[\w.-]+\Z", self.slug):
            raise C.CouldNotScan("cannot query the GitHub API: repository slug unknown (set GITHUB_REPOSITORY "
                                 "or --github-repo)")
        url = "%s/repos/%s/commits/%s" % (self.base, self.slug, sha)
        cfg = ['url = "%s"' % url, 'header = "Accept: application/vnd.github+json"',
               'header = "X-GitHub-Api-Version: 2022-11-28"', 'header = "User-Agent: supply-chain-guard"']
        if self.token:
            cfg.append('header = "Authorization: Bearer %s"' % self.token.replace('"', ""))
        try:
            p = subprocess.run(["curl", "-sS", "-f", "--proto", "=https,file", "--max-time", "30",
                                "--retry", "2", "-K", "-"], input=("\n".join(cfg) + "\n").encode(),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=C.tool_env())
        except OSError as e:
            raise C.CouldNotScan("cannot run curl: %s" % e)
        if p.returncode != 0:
            raise C.CouldNotScan("GitHub API lookup of %s failed (curl exit %d): %s"
                                 % (sha[:12], p.returncode, C.esc(C.first_line(p.stderr))))
        try:
            doc = json.loads(p.stdout.decode("utf-8"))
        except ValueError:
            raise C.CouldNotScan("GitHub API returned non-JSON for %s" % sha[:12])
        if not isinstance(doc, dict) or doc.get("sha") != sha:
            raise C.CouldNotScan("GitHub API returned a different object for %s" % sha[:12])
        self.cache[sha] = doc
        return doc

    def verified(self, sha):
        doc = self.commit(sha)
        ver = (doc.get("commit") or {}).get("verification") or {}
        return ver.get("verified") is True, str(ver.get("reason", ""))

    def as_commit(self, sha):
        doc = self.commit(sha)
        c = doc.get("commit") or {}

        def ident(x):
            x = x or {}
            return (x.get("name", ""), x.get("email", ""), x.get("date", ""), "")
        return Commit(sha, (c.get("tree") or {}).get("sha"), [p.get("sha") for p in doc.get("parents") or []],
                      ident(c.get("author")), ident(c.get("committer")), None, c.get("message", ""))


def _iso(ident):
    """Normalize an identity to (name, email, UTC ISO second)."""
    name, email, when, tz = ident
    if isinstance(when, int):
        when = datetime.datetime.fromtimestamp(when, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    else:
        try:
            when = datetime.datetime.strptime(when.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z") \
                .astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            pass
    return (name, email, when)


def is_replica(old, new):
    """Same parents, message, author and committer as the old tip, but a different tree."""
    if old.tree == new.tree:
        return False
    if list(old.parents) != list(new.parents):
        return False
    if old.message.rstrip() != new.message.rstrip():
        return False
    if old.signed is None or new.signed is None:   # one side came from the API: compare at second precision
        return _iso(old.author) == _iso(new.author) and _iso(old.committer) == _iso(new.committer)
    return old.author == new.author and old.committer == new.committer


# ---------------------------------------------------------------------------
def commits_in(repo, spec_args):
    p = repo.git(["rev-list", "--max-count=%d" % (MAX_COMMITS + 1)] + spec_args)
    shas = [s for s in p.stdout.decode("ascii", "replace").split() if s]
    if len(shas) > MAX_COMMITS:
        raise C.CouldNotScan("more than %d commits in range; refusing to verify a partial range" % MAX_COMMITS)
    return shas


def _have(repo, sha):
    return bool(sha) and sha != ZERO and repo.git(["cat-file", "-e", sha + "^{commit}"], ok=(0, 1, 128)).returncode == 0


def check_commits(repo, shas, checks, api, emit):
    for sha in shas:
        c = read_commit(repo, sha)
        if c is None:
            raise C.CouldNotScan("commit %s is not available locally (check out with fetch-depth: 0)" % sha[:12])
        if "C1" in checks and _RX_MERGE_SUBJ.match(c.subject) and len(c.parents) != 2:
            emit(Finding("C1", "commit:" + sha, 0, 0, "merge-style subject %r but %d parent(s)"
                         % (C.esc(c.subject[:60]), len(c.parents)), sha, allowlistable=False))
        if "C2" in checks:
            why = needs_github_signature(c)
            if why:
                if not c.signed:
                    emit(Finding("C2", "commit:" + sha, 0, 0, "%s but the commit carries no signature" % why,
                                 sha, allowlistable=False))
                else:
                    ok, reason = api.verified(sha)
                    if not ok:
                        emit(Finding("C2", "commit:" + sha, 0, 0, "%s but GitHub reports the signature as not "
                                     "verified (%s)" % (why, C.esc(reason[:40])), sha, allowlistable=False))


def check_push(repo, before, after, ref, forced, checks, api, emit):
    if not _RX_SHA.match(after or ""):
        raise C.CouldNotScan("push: 'after' is not a 40-hex sha")
    if not _have(repo, after):
        raise C.CouldNotScan("push: new tip %s is not available locally" % after[:12])
    new_branch = (not before) or before == ZERO
    have_before = (not new_branch) and _have(repo, before)
    if have_before and not forced:
        anc = repo.git(["merge-base", "--is-ancestor", before, after], ok=(0, 1)).returncode == 0
        forced = not anc
    if "C3" in checks and forced and not new_branch:
        if ref and _RX_PROTECTED.match(ref):
            emit(Finding("C3", "ref:" + ref, 0, 0, "forced push to protected branch %s" % C.esc(ref), ref,
                         allowlistable=False))
        old = read_commit(repo, before) if have_before else api.as_commit(before)
        new = read_commit(repo, after)
        if is_replica(old, new):
            emit(Finding("C3", "commit:" + after, 0, 0, "forged replica: new tip %s copies parents, message, author "
                         "and committer of the replaced tip %s but has a different tree"
                         % (after[:12], before[:12]), after, allowlistable=False))
    if have_before and not forced:
        shas = commits_in(repo, [after, "^" + before])
    else:
        # new branch, or old tip unreachable: commits not on any other ref
        refs = repo.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes",
                         "refs/tags"]).stdout.decode("utf-8", "surrogateescape").splitlines()
        short = ref[len("refs/heads/"):] if ref and ref.startswith("refs/heads/") else None
        excl = []
        for r in refs:
            sha, _, name = r.partition(" ")
            if sha == after or (short and name in ("refs/heads/" + short, "refs/remotes/origin/" + short)):
                continue
            excl.append("^" + sha)
        if have_before:
            excl.append("^" + before)
        shas = commits_in(repo, [after] + excl)
    check_commits(repo, shas, checks, api, emit)
    return len(shas)


def check_pr(repo, base, head, checks, api, emit):
    for name, s in (("base", base), ("head", head)):
        if not _RX_SHA.match(s or ""):
            raise C.CouldNotScan("pr: %s is not a 40-hex sha" % name)
        if not _have(repo, s):
            raise C.CouldNotScan("pr: %s %s is not available locally (check out with fetch-depth: 0)" % (name, s[:12]))
    shas = commits_in(repo, [head, "^" + base])
    check_commits(repo, shas, checks, api, emit)
    return len(shas)


# ---------------------------------------------------------------------------
# canary: crafted commit objects in a throwaway repo
# ---------------------------------------------------------------------------
def _mk_commit(repo, tree, parents, author, committer, msg, sig=False):
    lines = ["tree " + tree] + ["parent " + p for p in parents] + ["author " + author, "committer " + committer]
    if sig:
        lines += ["gpgsig -----BEGIN PGP SIGNATURE-----", " ", " wsBcBAABCAAQ", " -----END PGP SIGNATURE-----"]
    body = ("\n".join(lines) + "\n\n" + msg).encode("utf-8")
    return repo.git(["hash-object", "-t", "commit", "-w", "--stdin"], input=body).stdout.decode().strip()


def run_canary(checks, sabotage=None):
    tmp = tempfile.mkdtemp(prefix="scg-canary-")
    try:
        env = C.tool_env()
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        C.run_git(["init", "-q", tmp], cwd=tmp, env=env)
        with open(os.path.join(tmp, "f"), "w") as fh:
            fh.write("x\n")
        C.run_git(["add", "f"], cwd=tmp, env=env)
        repo = C.Repo(tmp, env=env)
        blob1 = repo.git(["hash-object", "-w", "--stdin"], input=b"one\n").stdout.decode().strip()
        blob2 = repo.git(["hash-object", "-w", "--stdin"], input=b"two\n").stdout.decode().strip()
        t1 = repo.git(["mktree"], input=("100644 blob %s\tf\n" % blob1).encode()).stdout.decode().strip()
        t2 = repo.git(["mktree"], input=("100644 blob %s\tf\n" % blob2).encode()).stdout.decode().strip()
        human = "Dev <dev@example.com> 1700000000 +0000"
        gh = "GitHub <noreply@github.com> 1700000000 +0000"
        root = _mk_commit(repo, t1, [], human, human, "root\n")
        side = _mk_commit(repo, t2, [root], human, human, "side\n")
        exp = {}
        found = []
        emit = found.append
        # C1: merge subject with one parent (positive) / two parents (negative)
        bad_merge = _mk_commit(repo, t1, [root], human, human,
                               "Merge pull request #1 from o/x\n" if sabotage != "C1" else "plain\n")
        good_merge = _mk_commit(repo, t1, [root, side], human, human, "Merge branch 'x'\n")
        exp["C1"] = {bad_merge}
        # C2: GitHub committer without signature (positive) / human committer (negative)
        forged = _mk_commit(repo, t1, [root], human, gh if sabotage != "C2" else human, "web edit\n")
        exp["C2"] = {forged}
        api = Api("canary/canary", base="file:///nonexistent", token="")
        check_commits(repo, [bad_merge, good_merge, forged, side], checks, api, emit)
        # C3: replica (positive) / honest rewrite (negative)
        old_tip = _mk_commit(repo, t1, [root], human, human, "feature\n")
        replica = _mk_commit(repo, t2, [root], human, human, "feature\n" if sabotage != "C3" else "other\n")
        honest = _mk_commit(repo, t2, [root], human, human, "feature v2\n")
        exp["C3"] = {replica}
        if "C3" in checks:
            if is_replica(read_commit(repo, old_tip), read_commit(repo, replica)):
                emit(Finding("C3", "commit:" + replica, 0, 0, "replica", replica))
            if is_replica(read_commit(repo, old_tip), read_commit(repo, honest)):
                emit(Finding("C3", "commit:" + honest, 0, 0, "replica", honest))
        got = {}
        for f in found:
            got.setdefault(f.check, set()).add(f.path.split(":", 1)[1])
        problems = []
        for check in checks:
            e, g = exp.get(check, set()), got.get(check, set())
            for miss in sorted(e - g):
                problems.append("%s missed its canary commit %s" % (check, miss[:12]))
            for extra in sorted(g - e):
                problems.append("%s false positive on its canary commit %s" % (check, extra[:12]))
        return problems
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
