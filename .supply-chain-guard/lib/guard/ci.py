"""guard-ci: what action.yml runs. Runs the three tools on $GITHUB_WORKSPACE, prints their output
with workflow-command processing stopped (untrusted text cannot inject ::commands::), then emits
::error annotations and a job summary from the JSON reports. Exit non-zero on any finding/error.
"""
import binascii
import json
import os
import subprocess
import sys
import tempfile

from . import common as C

TOOLS = (("scan-payload", C.PAYLOAD_CHECKS), ("supply-chain-check", C.SUPPLY_CHECKS),
         ("commit-provenance", C.PROVENANCE_CHECKS))


def _esc_data(s):
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _esc_prop(s):
    return _esc_data(s).replace(":", "%3A").replace(",", "%2C")


def _md(s):
    s = C.esc(s)
    for a, b in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ("|", "\\|"), ("`", "'"), ("[", "\\["), ("]", "\\]")):
        s = s.replace(a, b)
    return s


def _mode():
    mode = (os.environ.get("GUARD_MODE") or "").strip().lower()
    if mode in ("", "auto"):
        ev = os.environ.get("GITHUB_EVENT_NAME", "")
        if ev in ("pull_request", "pull_request_target", "merge_group"):
            return "pr"
        if ev == "push":
            return "push"
        return "full"
    if mode not in ("pr", "push", "full"):
        raise C.CouldNotScan("input mode must be pr, push or full (got %r)" % C.esc(mode))
    return mode


def main(argv):
    out = C.out
    try:
        mode = _mode()
        checks_spec = os.environ.get("GUARD_CHECKS") or "all"
        C.parse_checks(checks_spec, C.ALL_CHECKS)   # validate once, fail closed on typos
    except C.CouldNotScan as e:
        out("::error title=supply-chain-guard::%s" % _esc_data(str(e)))
        return C.EXIT_ERROR
    ws = os.environ.get("GITHUB_WORKSPACE") or os.getcwd()
    bindir = os.path.join(C.GUARD_ROOT, "bin")
    tmp = tempfile.mkdtemp(prefix="scg-ci-")
    reports, statuses = [], []
    # least privilege: only commit-provenance (the API caller) ever sees the token
    env = dict((k, v) for k, v in os.environ.items() if k not in ("GUARD_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"))
    env_api = dict(env)
    if os.environ.get("GUARD_TOKEN") or os.environ.get("GITHUB_TOKEN"):
        env_api["GITHUB_TOKEN"] = os.environ.get("GUARD_TOKEN") or os.environ.get("GITHUB_TOKEN")
    out("supply-chain-guard %s | mode=%s | checks=%s | workspace=%s" % (C.VERSION, mode, C.esc(checks_spec), C.esc(ws)))
    try:
        p = subprocess.run(["git", "-C", ws, "config", "--get-regexp", r"^http\..*\.extraheader$"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode == 0 and p.stdout.strip():
            out("::warning title=supply-chain-guard::the checkout persisted credentials; use "
                "actions/checkout with persist-credentials: false")
    except OSError:
        pass
    for tool, owned in TOOLS:
        args = ["bash", os.path.join(bindir, tool), "--repo-dir", ws, "--checks", checks_spec]
        if tool == "commit-provenance":
            if mode == "full":
                out("commit-provenance: skipped (mode=full has no commit range)")
                continue
            args += ["--event"]
        jpath = os.path.join(tmp, tool + ".json")
        args += ["--json", jpath]
        if not C.parse_checks(checks_spec, owned):
            continue
        token = binascii.hexlify(os.urandom(16)).decode()
        out("::group::%s" % tool)
        out("::stop-commands::%s" % token)
        sys.stdout.flush()
        try:
            p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               env=env_api if tool == "commit-provenance" else env)
            text = p.stdout.decode("utf-8", "replace")
            rc = p.returncode
        except OSError as e:
            text, rc = "cannot run %s: %s\n" % (tool, e), C.EXIT_ERROR
        sys.stdout.write(text if text.endswith("\n") or not text else text + "\n")
        out("::%s::" % token)
        out("::endgroup::")
        doc = None
        try:
            with open(jpath) as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            pass
        if doc is None:
            doc = {"tool": tool, "status": C.EXIT_ERROR, "error": "no report written (exit %d)" % rc,
                   "findings": [], "allowlisted": [], "notes": []}
        # the stricter of the exit code and the report wins; unknown exit codes are errors
        doc["status"] = max(rc if rc in (0, 1, 2) else C.EXIT_ERROR, doc.get("status", C.EXIT_ERROR))
        reports.append(doc)
        statuses.append(doc["status"])

    for doc in reports:
        if doc.get("error"):
            out("::error title=%s could not scan::%s" % (_esc_prop(doc["tool"]), _esc_data(C.esc(doc["error"]))))
        for f in doc.get("findings", []):
            title = "%s %s" % (f["check"], f.get("title", ""))
            msg = "%s%s" % (f["message"], (" | fp=" + f["fingerprint"]) if f.get("allowlistable") else "")
            path = f.get("path", "")
            if path.startswith("commit:") or path.startswith("ref:") or not f.get("line"):
                out("::error title=%s::%s %s" % (_esc_prop(title), _esc_data(C.esc(path)), _esc_data(msg)))
            else:
                out("::error file=%s,line=%d,col=%d,title=%s::%s" % (
                    _esc_prop(path), f["line"], max(1, f.get("col") or 1), _esc_prop(title), _esc_data(msg)))
        for n in doc.get("notes", []):
            if n.startswith("S7 "):
                out("::notice title=S7 report only::%s" % _esc_data(C.esc(n)))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        lines = ["## supply-chain-guard %s" % C.VERSION, "",
                 "mode `%s`, checks `%s`" % (mode, _md(checks_spec)), "",
                 "| tool | result | findings | allowlisted |", "|---|---|---|---|"]
        for doc in reports:
            st = {0: "clean", 1: "FINDINGS", 2: "COULD NOT SCAN"}.get(doc["status"], "ERROR")
            lines.append("| %s | %s | %d | %d |" % (doc["tool"], st, len(doc.get("findings", [])),
                                                   len(doc.get("allowlisted", []))))
        errs = [d for d in reports if d.get("error")]
        for d in errs:
            lines += ["", "**%s could not scan:** %s" % (d["tool"], _md(d["error"]))]
        rows = [f for d in reports for f in d.get("findings", [])]
        if rows:
            lines += ["", "| check | location | message | allowlist fingerprint |", "|---|---|---|---|"]
            for f in rows[:300]:
                loc = "%s:%s" % (f["path"], f["line"]) if f.get("line") else f["path"]
                lines.append("| %s | %s | %s | %s |" % (f["check"], _md(loc), _md(f["message"][:200]),
                                                        f["fingerprint"] if f.get("allowlistable") else "not allowlistable"))
            if len(rows) > 300:
                lines.append("| | | %d more findings in the log | |" % (len(rows) - 300))
        try:
            with open(summary, "a") as fh:
                fh.write("\n".join(lines) + "\n")
        except OSError as e:
            out("::warning title=supply-chain-guard::cannot write the job summary: %s" % _esc_data(str(e)))

    worst = max(statuses) if statuses else C.EXIT_ERROR
    if not statuses:
        out("::error title=supply-chain-guard::no tool ran (checks=%s)" % _esc_data(C.esc(checks_spec)))
    out("supply-chain-guard: %s" % {0: "clean", 1: "FINDINGS", 2: "COULD NOT SCAN"}.get(worst, "ERROR"))
    return worst
