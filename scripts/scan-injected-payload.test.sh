#!/usr/bin/env bash
# Proof that the scanner catches what the original control missed.
#
# The first version of this gate was never tested, and every weakness below was
# found by trying them against it AFTER it had shipped as the response to a live
# incident. Each case here is one that measurably defeated it. A scanner nobody
# has attacked is a scanner nobody knows the strength of.
#
#   ./scripts/scan-injected-payload.test.sh

set -uo pipefail

SCANNER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scan-injected-payload.sh"
pass=0; fail=0

# Build a throwaway git repo containing one file, run the scanner in it, and
# assert on the outcome. A real repo is required because the scanner uses
# git grep — which is also what makes "not a git repo" a case worth covering.
attempt() {
  local name="$1" expected="$2" file="$3" content="$4"
  local dir; dir=$(mktemp -d)
  ( cd "$dir" && git init -q . \
    && mkdir -p "$(dirname "$file")" \
    && printf '%b' "$content" > "$file" \
    && git add -A && git -c user.email=t@t -c user.name=t commit -qm t ) >/dev/null 2>&1
  ( cd "$dir" && bash "$SCANNER" ) >/dev/null 2>&1
  local rc=$?
  local got; [ "$rc" -eq 0 ] && got="clean" || got="flagged"
  if [ "$got" = "$expected" ]; then
    printf '  ✓ %-58s %s\n' "$name" "$got"; pass=$((pass+1))
  else
    printf '  ✗ %-58s expected %s, got %s\n' "$name" "$expected" "$got"; fail=$((fail+1))
  fi
  rm -rf "$dir"
}

# Threshold is 150, measured: column-aligned literals in the real tree reach
# 111 consecutive spaces, so the bar sits above that and below the 199 an
# attacker would use to stay under an arbitrary 200.
PAD111=$(printf ' %.0s' $(seq 1 111))
PAD199=$(printf ' %.0s' $(seq 1 199))
NBSP=$(printf '\xc2\xa0%.0s' $(seq 1 200))

echo "── Scanner behaviour ──────────────────────────────────────────────────"

# Baseline: ordinary source must not trip anything, or the gate gets disabled
# by the first person it annoys.
attempt "ordinary source is not flagged"          clean   "src/a.js" 'const x = 1\nexport default x\n'
attempt "indented code is not flagged"            clean   "src/b.js" 'function f() {\n      return 1\n}\n'
# The measured tradeoff, pinned: real column-aligned object literals in this
# repo hit 111 consecutive spaces. If someone lowers the threshold below that,
# the gate starts crying wolf on honest code and gets switched off — which is
# strictly worse than a slightly higher bar.
attempt "column-aligned code at 111 spaces stays clean" clean "src/align.ts" "const m = {\n  a: 1,${PAD111}// aligned\n}\n"

echo "── The original payload ───────────────────────────────────────────────"
attempt "decoder markers"                         flagged "src/c.js" "var _\$_d692 = 1\n"
attempt "padded last line (the real shape)"       flagged "src/d.js" "};${PAD199}PAYLOAD\n"
attempt "createRequire bridge in ESM"             flagged "src/e.mjs" "const require = createRequire(import.meta.url)\n"

echo "── Evasions that defeated the original control ────────────────────────"
# Each of these was verified to score CLEAN against the first scanner.

# `-I` skipped any file git called binary; Node still runs it.
attempt "NUL byte hiding the file from -I"        flagged "src/f.js" "//\x00\nvar x=1;${PAD199}PAYLOAD\n"

# 200 was arbitrary; 199 is just as invisible in review.
attempt "199 spaces (under the old 200 bar)"      flagged "src/g.js" "var x=1;${PAD199}PAYLOAD\n"

# [[:space:]] is ASCII-only under git's regex engine.
attempt "Unicode NBSP padding"                    flagged "src/h.js" "var x=1;${NBSP}PAYLOAD\n"

# package.json declares the lifecycle hook this incident abused, and was not
# scanned at all.
attempt "padding inside package.json"             flagged "package.json" "{\"scripts\":{\"postinstall\":\"node -e \\\"${PAD199}X\\\"\"}}\n"

# The eval(atob( regex required both tokens, in order, on one line.
attempt "new Function(atob(...))"                 flagged "src/i.js" 'new Function(atob("x"))()\n'
attempt "(0,eval)(atob(...))"                     flagged "src/j.js" '(0,eval)(atob("x"))\n'
attempt "aliased eval"                            flagged "src/k.js" 'const e=eval; e(atob("x"))\n'
attempt "Buffer.from base64 instead of atob"      flagged "src/l.js" 'eval(Buffer.from("x","base64").toString())\n'
attempt "data: URL dynamic import"                flagged "src/m.js" 'import("data:text/javascript;base64,x")\n'
attempt "eval and atob split across lines"        flagged "src/n.js" 'eval(\n  atob("x")\n)\n'

echo "── Fail-closed ────────────────────────────────────────────────────────"
# The single most dangerous property of the original: a broken scan reported
# a clean tree. Running outside a git repo makes git grep exit 128.
outside=$(mktemp -d)
( cd "$outside" && bash "$SCANNER" ) >/dev/null 2>&1
if [ $? -ne 0 ]; then
  printf '  ✓ %-58s %s\n' "scan outside a git repo fails, not passes" "flagged"; pass=$((pass+1))
else
  printf '  ✗ %-58s %s\n' "scan outside a git repo fails, not passes" "REPORTED CLEAN"; fail=$((fail+1))
fi
rm -rf "$outside"

echo "───────────────────────────────────────────────────────────────────────"
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
