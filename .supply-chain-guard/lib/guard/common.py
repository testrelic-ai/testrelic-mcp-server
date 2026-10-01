"""Shared plumbing for supply-chain-guard: git access, findings, allowlist, output.

python3 stdlib only; must run on 3.7+ (Amazon Linux 2023 ships 3.9) and under LC_ALL=C.
Every helper that cannot do its job raises CouldNotScan, which the entry points turn into
exit status 2 ("could not scan"). Nothing here ever turns an error into a pass.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

VERSION = "1.0.0"

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_ERROR = 2

ALLOW_FILE = ".supply-chain-guard.allow"
GUARD_DIR = ".supply-chain-guard"

# lib/guard/common.py -> lib/guard -> lib -> <guard root>
GUARD_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class CouldNotScan(Exception):
    """A check could not run. The run must fail closed (exit 2), never pass."""


# ---------------------------------------------------------------------------
# check registry
# ---------------------------------------------------------------------------
PAYLOAD_CHECKS = ("P1", "P2", "P2b", "P3", "P4", "P5", "P5b", "P6", "P7", "P8")
SUPPLY_CHECKS = ("S1", "S2", "S3", "S4", "S5", "S6", "S7")
PROVENANCE_CHECKS = ("C1", "C2", "C3")
ALL_CHECKS = PAYLOAD_CHECKS + SUPPLY_CHECKS + PROVENANCE_CHECKS

# Checks an allowlist entry may name. P1 is never allowlistable. P2/P2b/P3 are never allowlistable
# in code, config or any file a tool can execute; they are allowlistable (exact line fingerprint +
# reason) ONLY in inert data/doc files (see is_inert_data), so one legit OpenAPI/i18n JSON, CLI
# fixture .txt or wide markdown table cannot hard-block merges and deploys with no escape.
# P8 and S6-in-workflows are unreachable anyway because of the forbidden-path rule.
ALLOWLISTABLE = frozenset(("P4", "P5", "P5b", "P6", "P7", "S1", "S2", "S3", "S4", "S5", "S6"))
DATA_ONLY_ALLOWLISTABLE = frozenset(("P2", "P2b", "P3"))

JS_EXT = frozenset(("js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"))
LOCKFILES = frozenset(("package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
                       "bun.lock", "bun.lockb", "Cargo.lock", "deno.lock", "composer.lock",
                       "Gemfile.lock", "poetry.lock", "uv.lock"))
# Inert data/doc files: nothing in a normal toolchain executes them. JSON is inert except the
# manifests, lockfiles and the JSON configs that carry commands (VS Code tasks run on folder open,
# devcontainer lifecycle commands, vercel/nodemon/turbo/nx/firebase commands, deno tasks).
INERT_DATA_EXT = frozenset(("md", "markdown", "txt", "text", "csv", "tsv", "log", "rst", "adoc", "asciidoc", "json",
                            "jsonl", "ndjson", "geojson"))
COMMAND_JSON = frozenset(("package.json", "composer.json", "deno.json", "vercel.json", "now.json", "nodemon.json",
                          "turbo.json", "nx.json", "project.json", "lerna.json", "firebase.json", "app.json",
                          "netlify.json", "devcontainer.json", ".devcontainer.json", "tasks.json", "launch.json",
                          "renovate.json", "amplify.json", "manifest.json", "angular.json", "workspace.json"))
COMMAND_DIRS = frozenset((".vscode", ".devcontainer", ".github", ".idea", ".husky", ".supply-chain-guard"))


def ext_of(path):
    base = path.rsplit("/", 1)[-1]
    if "." not in base.lstrip("."):
        return ""
    return base.rsplit(".", 1)[-1].lower()


def is_inert_data(path):
    """A doc/data file nothing executes (md, txt, csv, data JSON, ...). Path-only decision."""
    parts = path.split("/")
    base = parts[-1]
    ext = ext_of(path)
    if ext not in INERT_DATA_EXT or base in LOCKFILES or base.lower() in COMMAND_JSON:
        return False
    if any(p in COMMAND_DIRS for p in parts[:-1]):
        return False
    return True


def allowlistable_for(check, path):
    """Could an allowlist entry cover this finding? Also false where entries may never point
    (.github/workflows/*, the allowlist itself, .supply-chain-guard/*), so the report never offers
    an fp= that the allowlist would reject."""
    if Allowlist._path_error(path) is not None:
        return False
    if check in ALLOWLISTABLE:
        return True
    return check in DATA_ONLY_ALLOWLISTABLE and is_inert_data(path)


CHECK_TITLES = {
    "P1": "campaign signature",
    "P2": "blank padding hides trailing code",
    "P2b": "tab padding hides trailing code",
    "P3": "long padded line",
    "P4": "dynamic code execution",
    "P5": "decoder + dynamic execution",
    "P5b": "long base64 string literal",
    "P6": "createRequire loader preamble",
    "P7": "npm lifecycle script",
    "P8": "local guard copy differs from the action",
    "S1": "JS lockfile (npm/yarn/bun/deno) / dependency spec",
    "S2": "pnpm lockfile",
    "S3": "Cargo.lock",
    "S4": "install scripts",
    "S5": "registry / install config",
    "S6": "GitHub Actions",
    "S7": "Docker base image not digest-pinned (report only)",
    "C1": "merge subject without two parents",
    "C2": "GitHub/bot commit without verified signature",
    "C3": "forced push / forged replica",
    "AL": "allowlist",
}


def parse_checks(spec, owned):
    """Return the subset of `owned` selected by a comma list ("all" or ids).

    Unknown ids are an error (a typo must not silently disable checks)."""
    spec = (spec or "all").strip()
    if spec.lower() == "all" or spec == "":
        return list(owned)
    want = []
    for tok in spec.split(","):
        tok = tok.strip()
        if not tok:
            continue
        if tok not in ALL_CHECKS:
            raise CouldNotScan("unknown check id %r in --checks (known: %s)" % (tok, ",".join(ALL_CHECKS)))
        want.append(tok)
    return [c for c in owned if c in want]


# ---------------------------------------------------------------------------
# environment / git
# ---------------------------------------------------------------------------
_STRIP_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
              "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CONFIG_PARAMETERS",
              "GIT_CONFIG_COUNT", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_EXTERNAL_DIFF",
              "GIT_PAGER", "PAGER", "GIT_GREP_OPTIONS", "GREP_OPTIONS", "GIT_REPLACE_REF_BASE",
              "GIT_NO_REPLACE_OBJECTS", "GIT_SHALLOW_FILE", "GIT_QUARANTINE_PATH")


def tool_env():
    """Environment for every child process: byte-mode C locale, no repo redirection."""
    env = {}
    for k, v in os.environ.items():
        if k in _STRIP_ENV or k.startswith("GIT_CONFIG_KEY_") or k.startswith("GIT_CONFIG_VALUE_"):
            continue
        if k.startswith("LC_") or k in ("LANG", "LANGUAGE"):
            continue
        env[k] = v
    # One fixed, always-available locale: git grep -P then runs PCRE in byte mode, so the
    # result never depends on which locales the runner has (the Amplify failure mode).
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_NO_REPLACE_OBJECTS"] = "1"   # refs/replace must not swap the objects we inspect
    return env


GIT_C = ["-c", "core.quotePath=false", "-c", "color.ui=never", "-c", "color.grep=never",
         "-c", "grep.lineNumber=false", "-c", "grep.column=false", "-c", "grep.fullName=false",
         "-c", "grep.patternType=perl", "-c", "grep.extendedRegexp=false",
         "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]


def first_line(b):
    if isinstance(b, bytes):
        b = b.decode("utf-8", "replace")
    b = b.strip()
    return b.splitlines()[0] if b else ""


def run_git(args, cwd, env, ok=(0,), input=None):
    try:
        p = subprocess.run(["git"] + GIT_C + list(args), cwd=cwd, env=env, input=input,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise CouldNotScan("cannot run git: %s" % e)
    if p.returncode not in ok:
        raise CouldNotScan("git %s failed (exit %d): %s" % (args[0], p.returncode, esc(first_line(p.stderr))))
    return p


class Repo(object):
    """A git working tree, its tracked files and their modes."""

    def __init__(self, path, env=None, min_files=1):
        self.env = env or tool_env()
        if not os.path.isdir(path):
            raise CouldNotScan("not a directory: %s" % esc(path))
        p = run_git(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], cwd=path, env=self.env,
                    ok=(0, 128))
        if p.returncode != 0:
            raise CouldNotScan("not a git repository (or git refused it): %s" % esc(first_line(p.stderr)))
        out = p.stdout.decode("utf-8", "surrogateescape").splitlines()
        if len(out) < 2 or out[0].strip() != "true" or not out[1].strip():
            raise CouldNotScan("not inside a git working tree: %s" % esc(path))
        self.root = out[1].strip()
        self.files = []        # list of (path_str, mode_str) for stage-0 / first-seen entries
        self.modes = {}
        raw = run_git(["ls-files", "-z", "-s"], cwd=self.root, env=self.env).stdout
        for rec in raw.split(b"\0"):
            if not rec:
                continue
            meta, _, path_b = rec.partition(b"\t")
            parts = meta.split(b" ")
            if len(parts) != 3 or not path_b:
                raise CouldNotScan("unparseable git ls-files record")
            mode = parts[0].decode("ascii", "replace")
            pth = path_b.decode("utf-8", "surrogateescape")
            if pth in self.modes:
                continue
            self.modes[pth] = mode
            self.files.append(pth)
        if len(self.files) < min_files:
            raise CouldNotScan("%d tracked files in %s; an empty or failed checkout cannot be reported clean"
                               % (len(self.files), esc(self.root)))
        self.regular = [f for f in self.files if self.modes[f] in ("100644", "100755")]
        self.symlinks = [f for f in self.files if self.modes[f] == "120000"]
        self.gitlinks = [f for f in self.files if self.modes[f] == "160000"]
        missing = []
        for f in self.regular:
            full = self.abspath(f)
            try:
                st = os.lstat(full)
            except OSError:
                missing.append(f)
                continue
            if not stat.S_ISREG(st.st_mode) or not os.access(full, os.R_OK):
                missing.append(f)
        if missing:
            raise CouldNotScan("%d tracked file(s) missing, unreadable or not regular in the working tree "
                               "(first: %s); refusing to scan a partial tree" % (len(missing), esc(missing[0])))

    def abspath(self, rel):
        return os.path.join(os.fsencode(self.root), os.fsencode(rel))

    def read(self, rel):
        try:
            with open(self.abspath(rel), "rb") as fh:
                return fh.read()
        except OSError as e:
            raise CouldNotScan("cannot read %s: %s" % (esc(rel), e.strerror))

    def git(self, args, ok=(0,), input=None):
        return run_git(args, cwd=self.root, env=self.env, ok=ok, input=input)

    def grep_lines(self, patterns):
        """Every tracked-file line matching any PCRE pattern (byte mode, -a, NUL-safe).

        Returns {path: [(lineno, line_bytes_without_LF), ...]}. Output records are
        `path NUL lineno NUL content LF`: a path may hold LF but never NUL, content may hold NUL
        but never LF, so the stream is parsed strictly in that order."""
        args = ["grep", "-n", "-z", "-a", "-P", "--no-color", "--no-recurse-submodules"]
        for p in patterns:
            args += ["-e", p]
        p = self.git(args, ok=(0, 1, 128))
        bad = [l for l in p.stderr.decode("utf-8", "replace").splitlines()
               if l.strip() and not l.startswith("warning:")]
        if p.returncode == 128 or bad:
            raise CouldNotScan("git grep -P could not run (needs git built with PCRE): %s"
                               % esc(bad[0] if bad else first_line(p.stderr)))
        out = p.stdout
        res = {}
        i, n = 0, len(out)
        while i < n:
            j = out.find(b"\0", i)
            k = out.find(b"\0", j + 1) if j >= 0 else -1
            if j < 0 or k < 0 or not out[j + 1:k].isdigit():
                raise CouldNotScan("unparseable git grep output near byte %d" % i)
            e = out.find(b"\n", k + 1)
            if e < 0:
                e = n
            res.setdefault(out[i:j].decode("utf-8", "surrogateescape"), []).append(
                (int(out[j + 1:k]), out[k + 1:e]))
            i = e + 1
        if p.returncode == 0 and not res:
            raise CouldNotScan("git grep reported matches but printed none")
        return res


# ---------------------------------------------------------------------------
# text helpers
# ---------------------------------------------------------------------------
# The JavaScript WhiteSpace set (plus U+2028/U+2029), as spelled in the spec.
BLANK_CLASS = "\\t\\x0b\\x0c \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
BLANK_CHARS = frozenset("\t\x0b\x0c       　﻿"
                        + "".join(chr(c) for c in range(0x2000, 0x200b)))
_RX_BLANKRUN8 = re.compile("[%s]{8,}" % BLANK_CLASS)


def sha256_hex(b):
    if isinstance(b, str):
        b = b.encode("utf-8", "surrogateescape")
    return hashlib.sha256(b).hexdigest()


def esc(s):
    """Render untrusted text as printable ASCII only (no control chars, no workflow commands)."""
    if isinstance(s, bytes):
        s = s.decode("utf-8", "surrogateescape")
    out = []
    for ch in s:
        o = ord(ch)
        if ch == "\\":
            out.append("\\\\")
        elif 0x20 <= o < 0x7f:
            out.append(ch)
        elif ch == "\t":
            out.append("\\t")
        elif 0xdc80 <= o <= 0xdcff:
            out.append("\\x%02x" % (o - 0xdc00))
        elif o < 0x100:
            out.append("\\x%02x" % o)
        elif o < 0x10000:
            out.append("\\u%04x" % o)
        else:
            out.append("\\U%08x" % o)
    return "".join(out)


def excerpt(line, col0, before=40, after=80):
    """At most before+after (=120) source chars around the match start, blank runs collapsed."""
    lo = max(0, col0 - before)
    hi = min(len(line), col0 + after)
    win = line[lo:hi]

    def _collapse(m):
        return "\x00%d blanks\x01" % len(m.group(0))

    win = _RX_BLANKRUN8.sub(_collapse, win)
    s = esc(win).replace("\\x00", "[").replace("\\x01", "]")
    return ("..." if lo > 0 else "") + s + ("..." if hi < len(line) else "")


def line_col(text, offset):
    """1-based (line, col) of a char offset in text."""
    line = text.count("\n", 0, offset) + 1
    start = text.rfind("\n", 0, offset) + 1
    return line, offset - start + 1


def norm_rel(base_dir, rel):
    """Resolve rel against base_dir (both repo-relative, '/' separated). None if outside the repo."""
    if rel.startswith("/") or rel.startswith("~") or "\\" in rel or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", rel):
        return None   # absolute, home-relative, Windows, or any scheme (https:, git+ssh:, C:)
    parts = [p for p in (base_dir.split("/") if base_dir else []) if p]
    for seg in rel.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts)


# ---------------------------------------------------------------------------
# findings
# ---------------------------------------------------------------------------
class Finding(object):
    def __init__(self, check, path, line, col, message, value, context="", allowlistable=None, tool="",
                 title=None):
        self.check = check
        # a rule-specific title (e.g. a P5 decoder that needs no executor) beats the generic one,
        # so the ::error annotation never claims an executor the file does not have
        self.title = title or CHECK_TITLES.get(check, "")
        self.path = path
        self.line = int(line or 0)
        self.col = int(col or 0)
        self.message = message
        self.value = value if value is not None else ""
        self.fingerprint = sha256_hex(self.value)
        self.context = context
        if allowlistable is None:
            allowlistable = allowlistable_for(check, path)
        self.allowlistable = allowlistable
        self.allowed_by = None
        self.tool = tool

    def key(self):
        return (self.check, self.path, self.fingerprint)

    def as_dict(self):
        return {"tool": self.tool, "check": self.check, "title": self.title,
                "path": self.path, "line": self.line, "col": self.col, "message": self.message,
                "context": self.context, "fingerprint": self.fingerprint,
                "allowlistable": bool(self.allowlistable),
                "allowlisted": self.allowed_by is not None,
                "allow_reason": self.allowed_by["reason"] if self.allowed_by else ""}

    def render(self):
        loc = "%s:%d:%d" % (esc(self.path), self.line, self.col)
        s = "%s: %s %s: %s" % (loc, self.check, self.title, self.message)
        if self.context:
            s += " | " + self.context
        if self.allowlistable:
            s += " | fp=%s" % self.fingerprint
        else:
            s += " | not allowlistable"
        return s


# ---------------------------------------------------------------------------
# allowlist
# ---------------------------------------------------------------------------
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")


def owner_of(check_id):
    if check_id in SUPPLY_CHECKS:
        return "supply-chain-check"
    return "scan-payload"


class Allowlist(object):
    """`.supply-chain-guard.allow`: <check-id>\\t<path>\\t<sha256>\\t<reason> per line.

    Literal paths only (no globs), per-check, per-fingerprint, mandatory reason. Entries may never
    target .github/workflows/*, the allowlist itself or .supply-chain-guard/*."""

    def __init__(self, repo):
        self.entries = []
        self.errors = []     # (lineno, check_id_or_None, message)
        self.present = ALLOW_FILE in getattr(repo, "modes", {}) if repo is not None else False
        if not self.present:
            return
        if repo.modes[ALLOW_FILE] not in ("100644", "100755"):
            self.errors.append((1, None, "%s must be a regular file" % ALLOW_FILE))
            return
        text = repo.read(ALLOW_FILE).decode("utf-8", "surrogateescape")
        seen = set()
        for n, raw in enumerate(text.split("\n"), 1):
            line = raw[:-1] if raw.endswith("\r") else raw
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            fields = line.split("\t", 3)
            if len(fields) != 4:
                self.errors.append((n, None, "expected 4 TAB-separated fields <check-id> <path> <sha256> <reason>"))
                continue
            cid, path, fp, reason = fields
            cid_known = cid if cid in ALL_CHECKS else None
            if cid not in ALL_CHECKS:
                self.errors.append((n, None, "unknown check id %r" % esc(cid)))
                continue
            if cid not in ALLOWLISTABLE and cid not in DATA_ONLY_ALLOWLISTABLE:
                self.errors.append((n, cid, "check %s cannot be allowlisted" % cid))
                continue
            perr = self._path_error(path)
            if perr:
                self.errors.append((n, cid_known, perr))
                continue
            if cid in DATA_ONLY_ALLOWLISTABLE and not is_inert_data(path):
                self.errors.append((n, cid, "check %s cannot be allowlisted in code, config or executable files; "
                                            "only in inert data/doc files (%s, data JSON)"
                                    % (cid, " ".join(sorted(INERT_DATA_EXT - {"json"})))))
                continue
            if not _HEX64.match(fp):
                self.errors.append((n, cid_known, "fingerprint must be 64 lowercase hex chars (sha256), no globs"))
                continue
            if not reason.strip():
                self.errors.append((n, cid_known, "entry has no reason"))
                continue
            k = (cid, path, fp)
            if k in seen:
                self.errors.append((n, cid_known, "duplicate entry"))
                continue
            seen.add(k)
            self.entries.append({"line": n, "check": cid, "path": path, "fp": fp,
                                 "reason": reason.strip(), "used": False})

    @staticmethod
    def _path_error(path):
        if not path or path != path.strip():
            return "path is empty or has surrounding whitespace"
        if any(c in path for c in "*?"):
            return "globs are not allowed (literal paths only)"
        if path.startswith("/") or path.startswith("./") or "\\" in path:
            return "path must be repo-relative with '/' separators"
        segs = path.split("/")
        if any(s in ("", ".", "..") for s in segs):
            return "path must be normalized (no empty, '.' or '..' segments)"
        if path == ALLOW_FILE:
            return "entries may not target the allowlist itself"
        if path == GUARD_DIR or path.startswith(GUARD_DIR + "/"):
            return "entries may not target %s/" % GUARD_DIR
        if path.startswith(".github/workflows/") or path == ".github/workflows":
            return "entries may not target .github/workflows/*"
        return None

    def apply(self, findings):
        idx = {}
        for e in self.entries:
            idx.setdefault((e["check"], e["path"], e["fp"]), e)
        for f in findings:
            if not f.allowlistable:
                continue
            e = idx.get(f.key())
            if e is not None:
                f.allowed_by = e
                e["used"] = True

    def problems(self, tool, ran_checks):
        """AL findings owned by `tool`: format errors and stale entries for checks that ran."""
        out = []
        for n, cid, msg in self.errors:
            if (cid is not None and owner_of(cid) != tool) or (cid is None and tool != "scan-payload"):
                continue
            out.append(Finding("AL", ALLOW_FILE, n, 1, msg, "%d" % n, allowlistable=False, tool=tool))
        for e in self.entries:
            if owner_of(e["check"]) != tool or e["check"] not in ran_checks or e["used"]:
                continue
            out.append(Finding("AL", ALLOW_FILE, e["line"], 1,
                               "stale entry: %s %s matches nothing; remove it" % (e["check"], esc(e["path"])),
                               "%d" % e["line"], allowlistable=False, tool=tool))
        return out


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------
def out(s=""):
    sys.stdout.write(s + "\n")


def banner(tool, repo_root=None, extra=None):
    try:
        gv = subprocess.run(["git", "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=tool_env()).stdout.decode("ascii", "replace").strip()
    except OSError:
        gv = "git: not found"
    out("%s %s | %s | python %s | engine locale LC_ALL=C (caller LC_ALL=%s LANG=%s)" % (
        tool, VERSION, gv, sys.version.split()[0], esc(os.environ.get("LC_ALL", "")),
        esc(os.environ.get("LANG", ""))))
    if repo_root:
        out("repo: %s%s" % (esc(repo_root), (" | " + extra) if extra else ""))


def finish(tool, findings, notes, error, json_path, ran_checks):
    """Print the report, write JSON, return the exit status."""
    blocking = [f for f in findings if f.allowed_by is None]
    allowed = [f for f in findings if f.allowed_by is not None]
    for n in notes:
        out("note: " + n)
    for f in sorted(blocking, key=lambda f: (f.path, f.line, f.col, f.check)):
        out(f.render())
    for f in sorted(allowed, key=lambda f: (f.path, f.line, f.col, f.check)):
        out("allowlisted: %s:%d:%d %s (%s)" % (esc(f.path), f.line, f.col, f.check, esc(f.allowed_by["reason"])[:100]))
    if error:
        status = EXIT_ERROR
        out("%s: COULD NOT SCAN: %s" % (tool, error))
    elif blocking:
        status = EXIT_FINDINGS
    else:
        status = EXIT_OK
    out("%s: %s (%d finding(s), %d allowlisted, checks: %s)" % (
        tool, {0: "clean", 1: "FINDINGS", 2: "ERROR"}[status], len(blocking), len(allowed),
        ",".join(ran_checks) if ran_checks else "none"))
    if json_path:
        doc = {"tool": tool, "version": VERSION, "status": status, "error": error or "",
               "checks": list(ran_checks), "notes": list(notes),
               "findings": [f.as_dict() for f in blocking], "allowlisted": [f.as_dict() for f in allowed]}
        try:
            with open(json_path, "w") as fh:
                json.dump(doc, fh, indent=1, sort_keys=True)
        except OSError as e:
            out("%s: cannot write %s: %s" % (tool, esc(json_path), e.strerror))
            return EXIT_ERROR
    return status
