#!/usr/bin/env bash
#
# Supply-chain implant scanner.
#
# Written after an obfuscated dropper sat in 7 tracked files of this repo for
# 11 days (main, 2026-08-21 -> 2026-09-02) and rode 10 open Dependabot PRs.
# CodeQL, the test suite and the docker build all passed on every one of them,
# so this exists to catch the specific shape those gates cannot see.
#
# It deliberately does NOT match the marker string. That value is generated per
# injection -- main carried `5-864-du` while the PR branches carried `5-860-du`,
# and a scan for the first found none of the second. Detection is structural.
#
# Usage:  scripts/supply-chain-scan.sh [path]     (defaults to the repo root)
# Env:    MAX_LINE (default 2000)
#
# Threshold rationale: the longest legitimate source line in this repo is 522
# chars (packages/mcp/src/tools/ai/index.ts). Every implanted line measured
# between 7608 and 9504. 2000 sits ~4x above real code and ~4x below the
# payload, so it cannot false-positive on formatting and cannot be squeezed
# under without breaking the payload's own padding.
set -uo pipefail

ROOT="${1:-.}"
MAX_LINE="${MAX_LINE:-2000}"
FAILED=0

cd "$ROOT" || { echo "cannot cd to $ROOT"; exit 2; }

# Tracked source only. Lockfiles and vendored/minified output legitimately carry
# very long lines, so they are excluded from the length check by design.
mapfile -t FILES < <(git ls-files -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' \
  | grep -vE '(^|/)(node_modules|dist|build|coverage)/' \
  | grep -vE '\.min\.js$' \
  | grep -vE '(^|/)package-lock\.json$')

echo "supply-chain-scan: ${#FILES[@]} tracked source files, MAX_LINE=$MAX_LINE"

fail() { echo "::error file=$1::$2"; FAILED=1; }

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue

  # 1. Over-long line. The payload hides past ~300 columns of padding on a
  #    file's last line so it stays off-screen in an editor and in a diff view.
  read -r LEN LNO < <(awk 'length>m{m=length;n=NR}END{print m+0, n+0}' "$f")
  if [ "${LEN:-0}" -gt "$MAX_LINE" ]; then
    fail "$f" "line $LNO is $LEN chars (limit $MAX_LINE) - implants hide past column ~300 on a padded line"
  fi

  # 2. Dynamic code construction from an encoded blob. The loader reaches the
  #    Function constructor via atob()/base64 rather than a literal eval body.
  if grep -qE '\beval[[:space:]]*\(' "$f" && grep -qE '\batob[[:space:]]*\(|Buffer\.from\([^)]*base64' "$f"; then
    fail "$f" "eval() combined with base64 decoding - dynamic code construction from an encoded payload"
  fi

  # 3. A long base64 literal embedded in source. The stage-1 blob measured 7448
  #    chars; no legitimate source file here embeds anything close.
  if grep -qE "['\"][A-Za-z0-9+/=]{500,}['\"]" "$f"; then
    fail "$f" "embedded base64 literal >=500 chars"
  fi

  # 4. The observed marker family, kept as a cheap exact check for THIS actor.
  #    Structural checks above are the real gate; this is belt-and-braces.
  if grep -qE "global\.o[[:space:]]*=[[:space:]]*['\"][0-9]-[0-9]{3}-[a-z]{2}['\"]" "$f"; then
    fail "$f" "known implant marker (global.o='N-NNN-xx')"
  fi
done

if [ "$FAILED" -eq 0 ]; then
  echo "supply-chain-scan: clean"
else
  echo ""
  echo "supply-chain-scan: FAILED - do not merge, and do not rebase the branch (a rebase carries the payload forward)."
fi
exit "$FAILED"
