#!/usr/bin/env bash
# Detect the 2026-08-27 supply-chain payload, and the shapes it can trivially
# mutate into.
#
# WHY THIS IS A SCRIPT AND NOT AN INLINE WORKFLOW STEP: the first version of
# this control lived inline in one repo's pipeline, which meant the other two
# repos it also needed to protect never got it, and the one that had it could
# not be unit-tested. This runs identically in CI and on a laptop.
#
# ── What the original control got wrong, all measured, all fixed here ────────
#
# 1. IT FAILED OPEN. `if git grep ...; then status=1; fi` cannot tell exit 1
#    (no match) from exit 128 (the scan itself broke: bad pathspec, bad regex,
#    not a git repo). A typo silently converted the whole gate into a green
#    no-op. Every check below inspects the exit code explicitly and treats
#    anything that is not 0-or-1 as a FAILURE.
#
# 2. `-I` MADE IT BLIND. git treats a file with a NUL byte in its first 8000
#    bytes as binary, and `-I` then skips it — while `node --check` still
#    parses that file and Node still runs it. One 0x00 inside a comment hid a
#    fully-armed payload from all three signals. `-I` is gone; `-a` forces
#    text so a NUL cannot buy invisibility.
#
# 3. ASCII-ONLY PADDING. `[[:space:]]` under git's own regex matches ASCII
#    only, so padding built from U+00A0 or U+2000..U+200A sailed through. And
#    the 200-column threshold was arbitrary: 199 spaces scored clean while
#    already pushing content far past any reviewable width. Both fixed —
#    Unicode blanks are matched explicitly, and the bar is measured (150).
#
# 4. IT ONLY LOOKED AT *.js/*.cjs/*.mjs/*.ts. package.json — the file that
#    declares the npm lifecycle hook this incident abused, and the one file
#    present in every published tarball — was not scanned. Neither were .sh,
#    .yml or .py, all of which this repo executes. Now everything textual is
#    in scope, with a small, explicit exclusion list.
#
# 5. eval(atob( WAS TOO LITERAL. 9 of 10 obvious spellings bypassed it,
#    including `new Function(atob(`, `(0,eval)(`, aliasing, and simply putting
#    a newline between the two tokens. Replaced with a set of narrower
#    dynamic-execution patterns that do not depend on one exact phrasing.
#
# Exit 0 = clean. Exit 1 = something found, or the scan could not run.

set -uo pipefail

status=0
found_any=0

# Paths excluded from EVERY check. Deliberately short: each entry is a place
# where a match is meaningless, not merely inconvenient.
#   - this script and its test quote the patterns on purpose
#   - lockfiles and sourcemaps carry long machine-generated lines
#   - minified bundles are legitimately one enormous line
EXCLUDES=(
  ':!scripts/scan-injected-payload.sh'
  ':!scripts/scan-injected-payload.test.sh'
  ':!*.map'
  ':!*-lock.json'
  ':!*-lock.yaml'
  ':!package-lock.json'
  ':!pnpm-lock.yaml'
  ':!*.min.js'
  ':!*.min.css'
)

# Repo-local allowlist, so the SCRIPT stays byte-identical across every repo
# that uses it. Divergence is how one repo ended up with a scan and its sibling
# with none; a per-repo edit to this file would recreate that.
#
# Format: one git pathspec per line. `#` comments and blank lines ignored.
# Every entry must carry a reason on the line above it — an unexplained
# exclusion is indistinguishable from an attacker quietly adding one.
ALLOW_FILE="$(dirname "${BASH_SOURCE[0]}")/scan-injected-payload.allow"
if [ -f "$ALLOW_FILE" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -z "$line" ] && continue
    EXCLUDES+=(":!${line}")
  done < "$ALLOW_FILE"
  echo "note: ${#EXCLUDES[@]} exclusions in effect (see scan-injected-payload.allow)"
fi

# Run one git-grep check. Any exit code other than 0 (found) or 1 (not found)
# means the scan itself failed, which is reported as a finding rather than
# ignored — see note 1 above.
check() {
  local label="$1"; shift
  local out rc
  out=$(git grep -n -a "$@" 2>&1)
  rc=$?
  case "$rc" in
    0)
      printf '::error::%s\n' "$label"
      printf '%s\n' "$out" | cut -c1-200 | head -40
      found_any=1
      status=1
      ;;
    1) : ;;  # nothing found — the only good outcome
    *)
      printf '::error::scan step FAILED to run (exit %s): %s\n' "$rc" "$label"
      printf '%s\n' "$out" | head -10
      status=1
      ;;
  esac
}

echo "── Scanning for injected payloads ─────────────────────────────────────"

# [1] The known decoder identifiers from this incident. Cheap, exact, and the
#     first thing to check — but never sufficient on its own: six of the ten
#     infected platform files base64-encoded the payload and matched none of
#     these.
check "Known obfuscation markers (2026-08-27 incident)" \
  -F -e '_$_d692' -e '_$jsoToArr' -- "${EXCLUDES[@]}"

# [2] Off-screen padding — the signature that actually found the sixth file.
#     Threshold measured, not guessed: column-aligned object literals in this
#     repo legitimately reach 111 consecutive spaces, and 150 is the lowest
#     round bar above that which yields ZERO false positives across every
#     tracked .ts/.tsx/.js/.mjs — while still catching both the ~1,500-space
#     real payload and a deliberate 199-space evasion.
check "150+ consecutive spaces/tabs mid-line (payload hidden off-screen)" \
  -E '[ \t]{150,}[^ \t]' -- "${EXCLUDES[@]}"

#     Written with PCRE CODEPOINT escapes (\x{00A0}), not byte escapes
#     (\xc2\xa0): git runs PCRE in UTF-8 mode, where a byte escape means the
#     codepoint of that value, so the byte form silently matches nothing. That
#     is exactly the kind of quiet miss this whole file exists to prevent, and
#     the test below is what caught it.
check "150+ consecutive Unicode blanks (NBSP / en-quad / ideographic space)" \
  -P '[\x{00A0}\x{2000}-\x{200A}\x{202F}\x{205F}\x{3000}]{150,}' -- "${EXCLUDES[@]}"

# [3] Dynamic execution of decoded data. Several narrow patterns instead of
#     one literal phrase, so aliasing and reordering do not walk straight
#     past. This is the noisiest check; if a legitimate hit ever appears,
#     exclude that exact path here with a comment saying why.
#     Only EXECUTION primitives are listed, deliberately. Bare `atob(` and
#     `Buffer.from(x,'base64')` were tried here first and are unusable: this
#     repo decodes JWT payloads in two test-setup files, and a check that
#     cries wolf on legitimate code is a check somebody disables. Decoding is
#     not the hazard — decoding and then EXECUTING is, and a payload has to
#     reach one of these to run at all.
#     PCRE, for \b. Plain ERE has no word boundary, and without one `eval` hit
#     the middle of "retrieval(" and the prose "eval (Augur)" in comments —
#     four false positives on the real tree. A gate that fires on comments is
#     a gate that gets switched off. `\beval\(` with NO space permitted is the
#     narrow form: real calls are written `eval(`, prose is not.
check "Dynamic execution (eval / Function constructor / data: import)" \
  -P -e '\beval\(' \
     -e '[(,]\s*eval\s*[),]' \
     -e '\b(const|let|var)\s+\w+\s*=\s*eval\s*[;,]' \
     -e '\bnew\s+Function\s*\(' \
     -e '\bFunction\s*\.\s*constructor' \
     -e 'import\(\s*["'"'"']data:text/javascript' \
  -- '*.js' '*.cjs' '*.mjs' '*.ts' '*.tsx' '*.mts' '*.cts' "${EXCLUDES[@]}"

# [4] The injection's own entry point: pulling CommonJS `require` into an ESM
#     module. Legitimate uses exist, so this is reported for review rather
#     than treated as proof — but in this incident it was present in all ten
#     platform files and all six SDK files.
check "createRequire in ESM (the injection's bridge to require)" \
  -F -e 'createRequire(import.meta.url)' \
  -- '*.mjs' '*.js' '*.ts' "${EXCLUDES[@]}"

echo "───────────────────────────────────────────────────────────────────────"
if [ "$status" -eq 0 ]; then
  echo "✅ clean — no injected-payload signatures found"
elif [ "$found_any" -eq 1 ]; then
  echo "🔴 FINDINGS ABOVE. See the 2026-08-27 supply-chain incident."
else
  echo "🔴 the scan could not complete — treated as a failure, never as clean"
fi
exit "$status"
