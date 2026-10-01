"""Entry point for bin/scan-payload, bin/supply-chain-check, bin/commit-provenance, bin/guard-ci.

Invoked as `python3 -I -B lib/guard/main.py <tool> [args]` by the bash wrappers in bin/.
Exit status: 0 clean, 1 findings, 2 could not scan (fail closed).
"""
import os
import sys

if sys.version_info < (3, 7):
    sys.stdout.write("supply-chain-guard: COULD NOT SCAN: python >= 3.7 required, found %s\n" % sys.version.split()[0])
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import argparse  # noqa: E402
import json  # noqa: E402

from guard import common as C  # noqa: E402


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # usage errors are "could not scan", not argparse's exit 2 text only
        self.print_usage(sys.stdout)
        C.out("%s: COULD NOT SCAN: %s" % (self.prog, message))
        sys.exit(C.EXIT_ERROR)


def _common_args(p):
    p.add_argument("--repo-dir", default=".", help="working tree to check (default: current directory)")
    p.add_argument("--checks", default=os.environ.get("GUARD_CHECKS", "all"),
                   help="comma-separated check ids, or 'all' (default)")
    p.add_argument("--json", default=None, help="also write the report as JSON to this file")


def _sabotage():
    return os.environ.get("GUARD_SELFTEST_SABOTAGE") or None


def cmd_scan_payload(argv):
    from guard import payload
    p = _Parser(prog="scan-payload", description="Scan every tracked file for injected payloads (P1-P8).")
    _common_args(p)
    a = p.parse_args(argv)
    tool = "scan-payload"
    C.banner(tool)
    checks, notes = [], []
    try:
        checks = C.parse_checks(a.checks, C.PAYLOAD_CHECKS)
        if checks:
            probs = payload.run_canary(checks, sabotage=_sabotage())
            if probs:
                raise C.CouldNotScan("built-in canary failed, this machine cannot run the checks: " + "; ".join(probs))
            C.out("canary: %s detect their positive samples and pass their negative samples" % ",".join(checks))
        repo = C.Repo(a.repo_dir)
        C.out("repo: %s | %d tracked files (%d regular, %d symlinks, %d submodules)" % (
            C.esc(repo.root), len(repo.files), len(repo.regular), len(repo.symlinks), len(repo.gitlinks)))
        for g in repo.gitlinks:
            notes.append("submodule %s is not scanned (scan it in its own repository)" % C.esc(g))
        al = C.Allowlist(repo)
        allow_p4 = frozenset((e["path"], e["fp"]) for e in al.entries if e["check"] == "P4")
        findings = payload.scan(repo, checks, allow_p4) if checks else []
        al.apply(findings)
        findings += al.problems(tool, checks)
        return C.finish(tool, findings, notes, None, a.json, checks)
    except C.CouldNotScan as e:
        return C.finish(tool, [], notes, str(e), a.json, checks)


def cmd_supply_chain_check(argv):
    from guard import supply
    p = _Parser(prog="supply-chain-check", description="Lint lockfiles, registry config and workflows (S1-S7).")
    _common_args(p)
    a = p.parse_args(argv)
    tool = "supply-chain-check"
    C.banner(tool)
    checks, notes = [], []
    try:
        checks = C.parse_checks(a.checks, C.SUPPLY_CHECKS)
        if checks:
            probs = supply.run_canary(checks, sabotage=_sabotage())
            if probs:
                raise C.CouldNotScan("built-in canary failed, this machine cannot run the checks: " + "; ".join(probs))
            C.out("canary: %s detect their positive samples and pass their negative samples" % ",".join(checks))
        repo = C.Repo(a.repo_dir)
        C.out("repo: %s | %d tracked files" % (C.esc(repo.root), len(repo.files)))
        findings = supply.scan(repo, checks, notes) if checks else []
        al = C.Allowlist(repo)
        al.apply(findings)
        findings += al.problems(tool, checks)
        return C.finish(tool, findings, notes, None, a.json, checks)
    except C.CouldNotScan as e:
        return C.finish(tool, [], notes, str(e), a.json, checks)


def _event():
    name = os.environ.get("GITHUB_EVENT_NAME", "")
    path = os.environ.get("GITHUB_EVENT_PATH", "")
    if not path:
        raise C.CouldNotScan("--event needs GITHUB_EVENT_PATH")
    try:
        with open(path, "rb") as fh:
            doc = json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise C.CouldNotScan("cannot read the event payload %s: %s" % (C.esc(path), e))
    return name, doc


def cmd_commit_provenance(argv):
    from guard import provenance as P
    p = _Parser(prog="commit-provenance", description="Commit provenance for a PR or push range (C1-C3).")
    _common_args(p)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--range", help="PR mode: BASE..HEAD (40-hex shas)")
    g.add_argument("--push", action="store_true", help="push mode: needs --before/--after [--ref] [--forced]")
    g.add_argument("--event", action="store_true", help="derive the mode from GITHUB_EVENT_NAME/GITHUB_EVENT_PATH")
    p.add_argument("--before")
    p.add_argument("--after")
    p.add_argument("--ref", default="")
    p.add_argument("--forced", action="store_true")
    p.add_argument("--github-repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    a = p.parse_args(argv)
    tool = "commit-provenance"
    C.banner(tool)
    checks, notes = [], []
    try:
        checks = C.parse_checks(a.checks, C.PROVENANCE_CHECKS)
        if checks:
            probs = P.run_canary(checks, sabotage=_sabotage())
            if probs:
                raise C.CouldNotScan("built-in canary failed, this machine cannot run the checks: " + "; ".join(probs))
            C.out("canary: %s detect their positive samples and pass their negative samples" % ",".join(checks))
        repo = C.Repo(a.repo_dir)
        shallow = repo.git(["rev-parse", "--is-shallow-repository"]).stdout.decode().strip()
        if shallow == "true":
            raise C.CouldNotScan("shallow clone: check out with fetch-depth: 0")
        api = P.Api(a.github_repo)
        findings = []
        mode, base, head, before, after, ref, forced = None, None, None, a.before, a.after, a.ref, a.forced
        if a.range:
            mode = "pr"
            base, _, head = a.range.partition("..")
        elif a.push:
            mode = "push"
        else:
            name, doc = _event()
            if name in ("pull_request", "pull_request_target", "pull_request_review", "merge_group") \
                    or "pull_request" in doc:
                pr = doc.get("pull_request") or {}
                if name == "merge_group":
                    mg = doc.get("merge_group") or {}
                    base, head = mg.get("base_sha"), mg.get("head_sha")
                else:
                    base, head = (pr.get("base") or {}).get("sha"), (pr.get("head") or {}).get("sha")
                mode = "pr"
            elif name == "push":
                mode = "push"
                before, after, ref, forced = doc.get("before"), doc.get("after"), doc.get("ref", ""), \
                    bool(doc.get("forced"))
            else:
                raise C.CouldNotScan("event %r has no commit range; run commit-provenance only on "
                                     "pull_request or push" % C.esc(name))
        if not checks:
            n = 0
        elif mode == "pr":
            n = P.check_pr(repo, base, head, checks, api, findings.append)
        else:
            n = P.check_push(repo, before, after, ref, forced, checks, api, findings.append)
        C.out("mode: %s | %d commit(s) examined" % (mode, n))
        for f in findings:
            f.tool = tool
        return C.finish(tool, findings, notes, None, a.json, checks)
    except C.CouldNotScan as e:
        return C.finish(tool, [], notes, str(e), a.json, checks)


def cmd_self_test(argv):
    """Every check's built-in canary (one positive and one negative sample, synthesized at run time,
    scanned by the production code path), for all three tools, and nothing else. The quick
    "is this machine's detector working" step a pipeline runs before the scans; the scans run the
    same canaries again on their own, and tests/run is the full suite."""
    from guard import payload, provenance, supply
    p = _Parser(prog="self-test", description="Run the built-in canaries of every check (P, S and C).")
    p.parse_args(argv)
    C.banner("self-test")
    bad = []
    for name, mod, checks in (("scan-payload", payload, C.PAYLOAD_CHECKS), ("supply-chain-check", supply, C.SUPPLY_CHECKS),
                              ("commit-provenance", provenance, C.PROVENANCE_CHECKS)):
        try:
            probs = mod.run_canary(list(checks), sabotage=_sabotage())
        except C.CouldNotScan as e:
            probs = [str(e)]
        if probs:
            bad.append(name)
            C.out("self-test: %s canary FAILED: %s" % (name, "; ".join(probs)))
        else:
            C.out("self-test: %s canary ok (%s)" % (name, ",".join(checks)))
    if bad:
        C.out("self-test: COULD NOT SCAN: the detector is broken on this machine (%s)" % ", ".join(bad))
        return C.EXIT_ERROR
    C.out("self-test: ok")
    return C.EXIT_OK


def main(argv):
    if len(argv) < 2:
        C.out("usage: main.py {scan-payload|supply-chain-check|commit-provenance|self-test|ci} [args]")
        return C.EXIT_ERROR
    tool, rest = argv[1], argv[2:]
    try:
        if tool == "self-test":
            return cmd_self_test(rest)
        if tool == "scan-payload":
            return cmd_scan_payload(rest)
        if tool == "supply-chain-check":
            return cmd_supply_chain_check(rest)
        if tool == "commit-provenance":
            return cmd_commit_provenance(rest)
        if tool == "ci":
            from guard import ci
            return ci.main(rest)
    except C.CouldNotScan as e:
        C.out("%s: COULD NOT SCAN: %s" % (tool, e))
        return C.EXIT_ERROR
    except Exception as e:  # any crash is a failure, never a pass
        C.out("%s: COULD NOT SCAN: internal error %s: %s" % (tool, type(e).__name__, C.esc(str(e))[:300]))
        return C.EXIT_ERROR
    C.out("unknown tool %r" % C.esc(tool))
    return C.EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main(sys.argv))
