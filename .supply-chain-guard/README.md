# supply-chain-guard

Blocking supply-chain checks for a checked-out git repository, shipped as a composite GitHub
Action. It runs three tools:

| tool | checks | what it looks at |
|---|---|---|
| `bin/scan-payload` | P1-P8 | every tracked file, for injected payloads and the loaders that run them |
| `bin/supply-chain-check` | S1-S7 | lockfiles, registry config, install-script policy, GitHub Actions workflows |
| `bin/commit-provenance` | C1-C3 | the commits of a PR or a push, and forced pushes |

Every finding fails the job. A check that cannot run also fails the job ("could not scan"). There
is no warn-only mode. Existing issues are fixed, or allowlisted one by one with a reason.

The action is consumed **pinned to a 40-hex commit SHA**. The checks run from that pinned commit,
so a forged commit in the consuming repository cannot weaken them by editing them.

## Use it

```yaml
# .github/workflows/supply-chain-guard.yml in the consuming repository
name: supply-chain-guard
on:
  pull_request:
  push:
    branches: ['**']
permissions:
  contents: read
jobs:
  guard:
    name: supply-chain-guard
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-hex sha> # v4
        with:
          fetch-depth: 0              # commit-provenance needs the history
          persist-credentials: false  # no token left in .git/config
      - uses: testrelic-ai/supply-chain-guard@<40-hex sha> # v1
```

Make `supply-chain-guard` a required status check on main, stage and prod, and make every job
that runs repository code or holds secrets `needs:` it.

Inputs:

| input | default | meaning |
|---|---|---|
| `mode` | derived from the event | `pr` (base..head of the pull request), `push` (before..after, forced flag), `full` (no commit range: provenance is skipped). Empty means `pull_request`/`merge_group` -> `pr`, `push` -> `push`, anything else -> `full`. |
| `checks` | `all` | comma-separated check ids, e.g. `P1,P2,S6`. An unknown id fails the run. |

The action prints each tool's report with GitHub workflow-command processing stopped, so text
from the scanned repository cannot inject `::commands::`. It then emits one `::error` annotation
per finding and writes a summary table to the job summary.

## Exit status and output

All three tools exit `0` clean, `1` findings, `2` could not scan. The action fails on 1 and 2.

A finding is one line:

```
path:line:col: CHECK title: message | <at most 120 source chars around the match> | fp=<sha256>
```

The excerpt is cut to 40 chars before and 80 after the match start. Blank runs of 8 or more are
shown as `[N blanks]`, and every non-printable or non-ASCII char is escaped (`\xNN`, `\uNNNN`).
A CI log never carries a payload body. `fp=` is the allowlist fingerprint. Findings that cannot
be allowlisted say `not allowlistable` instead.

Every tool also takes `--repo-dir DIR`, `--checks LIST` and `--json FILE`.

## Checks

### scan-payload (every tracked file, `git ls-files`, read with `-a`)

| id | rule | files | allowlist |
|---|---|---|---|
| P1 | campaign signatures: `global.<name> = '<digits>-<digits>-<2 lowercase>'` assignment; `_$_` + 4 hex + `=`; `_$jso` + capitalised name; the base64 prefixes of `var _$_` and `global.o`; the two-line `createRequire` preamble (`import { createRequire } from 'module';` directly followed by `const require = createRequire(import.meta.url);`) | all, incl. lockfiles, `*.min.*`, maps, binaries | never |
| P2 | a run of >= 150 blank chars from the full JS whitespace set (space, `\t`, `\f`, `\v`, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), mixed freely, followed by a non-blank on the same line. A trailing run (or one followed only by the CR of a CRLF) is not a finding | all, except real binary media (*) | inert data/doc files only (**) |
| P2b | >= 16 consecutive tabs after a non-blank and followed by a non-blank | all, except real binary media (*) | inert data/doc files only (**) |
| P3 | line > 1000 chars containing a blank run >= 40 followed by >= 200 more chars | js mjs cjs jsx ts tsx mts cts json yml yaml sh py, not `*.min.*`, `*.map`, lockfiles | inert data/doc files only (**) |
| P4 | dynamic code execution, see "P4 rules" below | JS/TS family | per line |
| P5 | decoders, see "P5 rules" below: a decoder is a finding on its own when it is fed an inline literal or char codes, sits next to encoded blob literals, loads a local data file, is reached through a computed key, is a hand-rolled base64 alphabet, or is in a build/install/config-time file; and any P4 executor in a file that decodes is reported too | JS/TS family | per line |
| P5b | a quoted string literal of >= 400 base64-alphabet chars (any non-binary file, data JSON included); a literal holding >= 32 `\xHH`/`\uHHHH`/octal escapes; >= 3 quoted base64 literals of >= 48 chars in one JS file totalling >= 2000 chars (every chunk line is reported) | literal rule: all non-binary files; the others: JS/TS family | per line |
| P6 | `createRequire(` with `import.meta.*` or `new URL(` on the same line | JS/TS family | per line |
| P7 | `preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `postpack`, `prepublish`, `prepublishOnly`, `publish`, `postpublish`, `pnpm:devPreinstall` under `scripts` in any `package.json` (an unparseable `package.json` is also a finding) | `package.json` | per path + script + command |
| P8 | a local copy at `.supply-chain-guard/` must be byte-identical to the action's own files (sha256), and must contain all of `bin/`, `lib/` and `action.yml` | `.supply-chain-guard/*` | never |

The JS/TS family is `js mjs cjs jsx ts tsx mts cts`, plus extensionless files whose shebang
names node, tsx, ts-node, bun, deno or zx. Extensionless sh/bash/python scripts count as code
for P3. The P5 decoder rule accepts any text between `Buffer.from(` and `'base64'` on the line,
so nested parentheses such as `Buffer.from(parts.join(''), 'base64')` do not evade it.

(**) P2, P2b and P3 are never allowlistable in code, config or any file a toolchain executes. They
can be allowlisted (exact line fingerprint plus a reason, like every other entry) only in inert
data/doc files: `md markdown txt text csv tsv log rst adoc asciidoc json jsonl ndjson geojson`,
except `package.json`, lockfiles, command-bearing JSON (`vercel.json`, `nodemon.json`, `turbo.json`,
`nx.json`, `project.json`, `lerna.json`, `firebase.json`, `deno.json`, `tasks.json`, `launch.json`,
`devcontainer.json`, `renovate.json`, `manifest.json`, `angular.json`, ...) and anything under
`.vscode/`, `.devcontainer/`, `.github/`, `.idea/`, `.husky/`. The findings are still raised there
(a payload parked in a .txt and loaded with `node x.txt` is still caught); the allowlist only gives
a legitimate OpenAPI/i18n JSON, CLI-output fixture, banner or wide markdown table an escape that
does not require rewriting the file. `.mdx` is executable (MDX compiles JS) and is not inert.

### P4 rules (JS/TS family)

Executors, by call or by reference:

- `eval(`, bare `Function(` / `` Function` `` (tagged template), `new Function`, `Function.constructor`,
  `constructor('…` / `` constructor` ``, `.constructor.constructor`, `(…{}).constructor`
  (Function/AsyncFunction reached through any function), `['constructor']`;
- `vm.runIn*`, `runInThisContext`, `runInNewContext`, `compileFunction`, `module._compile(`,
  `new Worker(…, {eval: true})`, node spawned with inline code (`process.execPath`/`'node'` with
  `'-e'`/`'--eval'`/`'-p'`, `exec('node -e …')`);
- `setTimeout`/`setInterval` with a string or as a tagged template, `import('data:…` / `import('blob:…`;
- a dangerous name as a quoted computed key of any member expression: `globalThis['eval']`,
  `window["Function"]`, ``self[`eval`]``, `x?.['constructor']`, `(function(){return this})()['eval']`
  (eval, Function, execScript, constructor, setTimeout, setInterval, setImmediate, require,
  runIn*Context, compileFunction, _compile);
- a global object (`globalThis`, `window`, `global`, `self`) indexed by a non-literal key
  (`globalThis[k]`), or by a quoted key holding an escape or `${}` (`globalThis['\x65val']`);
  `this[<expression>](…)`; a global's `.eval` / `.Function` / `.execScript` property taken as a value;
- `eval` / `Function` used as a value: `(0, eval)(s)`, `{r: eval}`, `[eval]`, `x = eval;`, `eval`
  alone on a line before `(s)` on the next;
- `Reflect.get/apply/construct/getOwnPropertyDescriptor(globalThis|window|global|self|this, …)`,
  `Object.getOwnPropertyDescriptor(s)(globalThis, …)`, `, 'eval')` handed to any getter;
- a computed key produced by a decoder or a reversal: `o[String.fromCharCode(…)]`, `o[atob(…)]`;
- a name spelled from pieces: `'ev' + 'al'`, `['ev','al'].join('')`, `'lave'.split('').reverse().join('')`,
  an escape-encoded literal (`'\x65val'`), char codes (`String.fromCharCode(101,118,97,108)`),
  `'child_' + 'process'`, a concatenated `'da' + 'ta:'` URL for `import()`.

A line that can only be a comment is skipped for P4 (prose such as "eval (LLM evaluation)"): it
starts with `//`, or it starts with `/*` and its first `*/` ends the line. It is NOT skipped when it
contains a `{` (a JSX expression container or `${}` executes), a `*/` inside a `//` line (it may
close an open block comment) or text after the `*/`. JSDoc middle lines (` * …`) are scanned,
because a leading `*` can also be a multiplication.

One narrow exception, for the value forms only (`{r: eval}`, `[Function]`, …; never `eval(`,
`new Function`, a quoted key or any other rule): a JSDoc middle line such as
` *   4. most-common per-test slug among {e2e, mobile, unit, eval}.` is prose when it starts with
`*` (not `*/`) and holds none of `(` `=` `?` `'` `"` `` ` `` `\` `${` `*/`, the line above starts
with `*` or opens a block comment (`/*`) and has no `*/`, and the line below starts with `*`.
Even if such a line were code it is a multiplication operand on both sides: nothing on it can call
(no `(`, no backtick, next line starts with `*`), assign (no `=`) or pick (no `?`) the name. A
bare `*` line under code, or one with a call, an assignment, a ternary, a quote or a template, is
still P4, and so is a value form whose next line does not start with `*`.

### P5 rules (JS/TS family)

Decoders: `atob(`, `Buffer.from(x, '<enc>')` / `new Buffer(x, '<enc>')` with enc base64, base64url,
hex, latin1, binary, ucs2 or utf16le (the decoding form; `Buffer.from(x).toString('base64')` encodes
and is not one), `String.fromCharCode` / `fromCodePoint` (a character constant of up to 7 numeric
literals, such as `String.fromCharCode(92)`, is not one), `TextDecoder`, `unescape(`,
`Uint8Array.fromBase64(` / `fromHex(`, a decoder reached through a quoted computed key
(`globalThis['atob']`), the 64-char base64 alphabet (a hand-rolled decoder), and `decodeURI(Component)`
fed a literal of >= 16 `%XX` escapes.

A decoder line is a P5 finding, with no executor needed, when:

- it is fed an inline literal of >= 32 chars or >= 8 numeric char codes / bytes;
- the file carries encoded blob material (a P5b literal, or >= 3 base64 literals of >= 48 chars
  totalling >= 400);
- the file loads a local data file (`import … from './x.json'`, `require('./x.txt')`,
  `readFileSync('./…')`, `readFileSync(join(__dirname, …))`, `new URL('./…', import.meta.url)`);
- it is a computed-key decoder or the base64 alphabet;
- the file is a build/install/config-time file: under a `scripts/`, `script/`, `tools/`, `tooling/`,
  `bin/`, `build/`, `ci/`, `.github/`, `.husky/`, `hooks/`, `migrations/` or `seeds/` directory; a
  `*.config.*`, `*.conf.*`, `.*rc.*`, `esbuild*`, `webpack*`, `rollup*`, `gulpfile*`,
  `gruntfile*`, `*install*`, `prepare*`, `prepack*`, `migrate*`, `seed*` JS file; a `.mjs`/`.cjs`
  at the repository root; a file any `package.json` script runs (`node scripts/x.cjs`); an
  extensionless node script;
- the file also has a P4 executor (then every executor line is P5 too).

Runtime code that decodes data it is handed (`Buffer.from(token, 'base64')` in a service) is not a
finding: a large application repository can have about 100 such lines. A P4 line that the repository
allowlists (by its exact fingerprint) no longer counts as an executor for P5, so a reviewed prose
line or test helper does not keep flagging the file's legitimate decoders.

Each P5 finding is titled by what was found (the `::error` annotation title and the report line):
`decoder + dynamic execution` only when the file has a P4 executor; otherwise `decoder fed an
inline literal`, `decoder next to encoded blobs`, `decoder loading a local data file`, `decoder
behind a computed key`, `hand-rolled base64 decoder` or `decoder in a build/install-time file`.

(*) Real binary media: a file whose extension is an image, font, archive, media, database or
native-binary type (png, jpg, woff2, pdf, zip, wasm, node, …) **and** whose content really is
binary (a NUL byte or invalid UTF-8). Compressed bytes that happen to look like tabs are not
hidden code. A real PNG test fixture had 31 0x09 bytes in its deflate stream.
A text file renamed to `.png` is still scanned, JS/code files are never exempt, and P1 applies
to every file.

### supply-chain-check

| id | rule |
|---|---|
| S1 | `package-lock.json` / `npm-shrinkwrap.json` (v1, v2, v3): every `resolved` is `https://registry.npmjs.org/…`; every entry that is not `link`, not `inBundle` and not a local package folder has a `sha512-` integrity; `link` targets and local package folders stay inside the repository. `yarn.lock` classic: every `resolved` is `https://registry.yarnpkg.com/…` or `https://registry.npmjs.org/…` with a `sha512-` integrity, `file:`/`link:` inside the repository, an entry with no `resolved` that is not local is a finding; yarn berry (`__metadata:`): every resolution is `npm:` with a checksum, `workspace:`, `patch:` of an npm package (patch file inside the repository) or a local protocol inside the repository, never git/http/exec. `bun.lock` (JSONC): npm entries come from the default or the npmjs registry with a `sha512-` integrity, no git/github/http/tarball specs, local specs inside the repository; `bun.lockb` (binary, unverifiable) is always a finding. `deno.lock` v2-v5: npm entries need `sha512-` integrity (tarballs only on npmjs), jsr entries a sha256, `remote` modules and `redirects` only from deno.land or jsr.io; an unknown version is a finding. Every `package.json` dependency, `overrides`, `resolutions` and `pnpm.overrides` spec is not `git+`, `git:`, `git@`, `github:`, `gitlab:`, `bitbucket:`, `gist:`, `http(s):`, an `owner/repo` shorthand, or a `file:`/`link:`/`portal:`/relative path outside the repository. |
| S2 | `pnpm-lock.yaml`: every `tarball:` is on registry.npmjs.org, every `resolution:` has `integrity:`, no git resolutions, no `directory:` and no importer `link:`/`file:` outside the repository. Resolutions the parser cannot account for are a finding. |
| S3 | `Cargo.lock`: every `source` is `registry+https://github.com/rust-lang/crates.io-index` or `sparse+https://index.crates.io/` (path crates have none), and registry crates have a sha256 `checksum`. |
| S4 | npm lockfile entries with `hasInstallScript: true` (allowlisted by package name, any version); a `pnpm-lock.yaml` without an explicit build allow list (`allowBuilds`, `onlyBuiltDependencies` or `onlyBuiltDependenciesFile` in the sibling `pnpm-workspace.yaml`, or `pnpm.onlyBuiltDependencies` in the sibling `package.json`); `dangerouslyAllowAllBuilds: true`; a `yarn.lock` without `enableScripts: false` (`.yarnrc.yml`) or `ignore-scripts true` (`.yarnrc` / `.npmrc`) beside it or at the root (yarn runs every dependency's install scripts). |
| S5 | `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`: any registry not `https://registry.npmjs.org/`, `ignore-scripts=false`; install-time code hooks: `.npmrc` `node-options` with `--require`/`-r`/`--import`/`--loader`, `onload-script`, `script-shell`, `git`, `init-module`; `.yarnrc` `yarn-path`; `.yarnrc.yml` `yarnPath`, `plugins`; `bunfig.toml` `preload`. Any `.pnpmfile.cjs`. A symlinked lockfile (npm, pnpm, yarn, bun, deno), manifest or registry config. |
| S6 | `.github/workflows/**.yml`, every `action.yml` and every `amplify.yml` (Amplify runs its commands at deploy): `uses:` must be `./local` or `owner/repo@<40-hex>` (a trailing `# v4` comment is fine); `docker://` must be `@sha256:` pinned (workflows and actions). Commands are read the way the shell receives them: YAML block scalars (`run: \|`, `run: >`), plain and quoted multi-line scalars and list items are folded, and lines ending in `\`, `\|`, `\|\|` or `&&` are joined to the next. Findings: `pull_request_target`; `permissions: write-all`; `curl`/`wget` piped into a shell, python, node, perl, ruby, bun, deno or pwsh; a download consumed through process substitution (`bash <(curl …)`, `source <(curl …)`, `. <(curl …)`); `sh -c "$(curl …)"`, `python3 -c "$(curl …)"`, `node -e "$(curl …)"`; `eval "$(curl …)"`; `$(curl …)` run as a command; a file downloaded by curl/wget (`-o`, `-O`, `--output`, `> file`, wget's default name) and later executed in the same step (`bash f`, `sh f`, `python3 f`, `source f`, `. f`, `./f`, `/tmp/f`); `base64 -d … \| sh`; registry or install-config changes at run time (`npm/pnpm/yarn/bun config set registry …`, `npm set @scope:registry …`, `--registry <url>` on anything but publish-type commands, writes to `.npmrc`/`.yarnrc(.yml)`/`bunfig.toml`/`.pnpmfile.cjs` that set a non-npmjs registry, a registry from a variable or a script hook, `NPM_CONFIG_REGISTRY`-style variables, `npm_config_ignore_scripts=false`, `NODE_OPTIONS` with `--require`/`--import`/`--loader`); packages run or installed from a non-registry source (`npx`, `pnpx`, `bunx`, `npm exec/x`, `pnpm/yarn dlx`, `npm/pnpm/yarn/bun install/i/add` with `github:`, `git+…`, `https://…`, an `owner/repo` shorthand or a path outside the repository, also through `--package`/`-p`); `toJSON(secrets)`; `${{ secrets.* }}` on an echo/printf/cat line. `registry-url:` of `actions/setup-node` and `npm publish --registry …` are not findings. |
| S7 | Dockerfile `FROM` without `@sha256:`. Report only: printed as a note and a `::notice`, never fails. |

### commit-provenance

```
commit-provenance --range BASE..HEAD
commit-provenance --push --before SHA --after SHA [--ref refs/heads/x] [--forced]
commit-provenance --event            # from GITHUB_EVENT_NAME / GITHUB_EVENT_PATH
```

| id | rule |
|---|---|
| C1 | a commit whose subject starts with `Merge pull request`, `Merge branch` or `Merge remote-tracking` must have exactly 2 parents. |
| C2 | a commit committed by `GitHub <noreply@github.com>`, or authored/committed by a `*[bot]`, must carry a signature that GitHub reports as verified (`GET /repos/{o}/{r}/commits/{sha}` -> `.commit.verification.verified`). An unsigned one fails without an API call. |
| C3 | on a forced push: a new tip with the same parents, message (trailing whitespace ignored), author and committer as the replaced tip but a different tree is a forged replica. Any forced push to `main`, `stage`, `prod` or `release/*` is a finding. The replaced tip is read locally, or from the API when the force push made it unreachable. |

The API is read-only, called with `curl`, authenticated with `GITHUB_TOKEN` (the action passes
`github.token`). A lookup that fails is "could not scan". A shallow clone is "could not scan".

## Allowlist: `.supply-chain-guard.allow`

One entry per line, four TAB-separated fields. `#` comments and blank lines are ignored.

```
<check-id>	<path>	<fingerprint>	<reason>
```

- `fingerprint` is the `fp=` the tool printed: the sha256 (64 lowercase hex) of
  - P2, P2b, P3 (inert data/doc files only), P4, P5, P5b, P6: the exact matching line, without its
    LF (and without a trailing CR);
  - P7: `<script-name>=<command>`, e.g. `postinstall=node scripts/postinstall.cjs`;
  - S1: `<lock entry key>` TAB `<field>=<value>`, or `<section>` TAB `<name>=<spec>` for a
    `package.json` spec;
  - S2: `<package key>` TAB `<field>=<value>`;  S3: `<name>@<version>` TAB `source=…`/`checksum=<missing>`;
  - S4: the package name (any version), or `pnpm-build-allowlist-missing`;
  - S5: the exact config line (for `.pnpmfile.cjs`, the whole file);
  - S6: the `uses:` ref (e.g. `actions/cache@v4`), the exact line for a command on one line, or
    the whole folded command for one that spans lines.
- `path` is a literal repo-relative path. No globs (`*`, `?`), no `..`, no leading `/` or `./`.
- `reason` is required.
- Never allowlistable: P1, P8, C1-C3, and P2/P2b/P3 in anything but an inert data/doc file (an
  entry naming P2/P2b/P3 for a code or config path is rejected). Entries may never target
  `.github/workflows/*`, the allowlist itself, or `.supply-chain-guard/*`.
- An entry that no longer matches anything (stale) is a finding. So is a malformed entry and a
  duplicate. An entry is judged only when its check ran.

## Running without GitHub Actions (Amplify, local)

Keep a byte-identical copy of this repository's `bin/`, `lib/` and `action.yml` at
`.supply-chain-guard/` in the consuming repository and run it before `npm ci`:

```
bash .supply-chain-guard/bin/scan-payload && bash .supply-chain-guard/bin/supply-chain-check
```

P8 in the pinned action then fails any pull request whose local copy differs from the pinned
version. A local copy alone runs the tree's own code, so it is a second gate, never the only one.
`tools/adoption-patch` vendors the whole toolkit there (P8 accepts any of its files and requires
`bin/`, `lib/` and `action.yml`).

## How the scanner stays honest

- **One engine, any locale.** Every child process runs under `LC_ALL=C`, so `git grep -P` is
  always in PCRE byte mode. Results never depend on which locales a runner has. The phase-1
  Amplify failures came from the locale: PCRE UTF mode is only on under a UTF-8 locale, so the
  same pattern behaved differently there.
- **Prefilter, then exact.** One `git grep -n -z -a -P` pass selects candidate *lines* with
  patterns that are supersets of the exact rules. The P2 prefilter, for example, is one byte class
  repeated, so it cannot overflow the PCRE JIT stack. Python then applies the exact rules to those
  lines only. The prefilter can only add work. It never hides a hit. git grep's look-ahead runs
  the pattern over the whole remaining buffer, so no prefilter may match a newline or use `^`/`$`,
  and the canary places hits below line 1 to prove it.
  The prefilter goes to git as **one** alternation. With several `-e` patterns, look-ahead
  re-scans the rest of the file with every non-matching pattern after each hit. That is
  quadratic: a 10 MB file whose every line matched one branch ran for over 16 minutes. `--or`
  is no better. Every branch starts with a literal, a word boundary plus a literal, or a narrow
  byte class, so PCRE2 skips impossible start positions; one branch that can start at any byte
  makes every byte try every branch (round 2 measured 7 s instead of 2 s for the grep on
  a large repository). The executor and decoder names share one word-group branch, and one
  run-anchored 40-blank branch serves both P2 and P3. Each exact rule also sits behind a literal
  gate that all of its branches require.
  - a 2,170-file, 20 MB application repository: about 7 s, canary included (WSL); v1 took about 5 s.
  - 66 MB of adversarial dense-match files: 24 s (v1 measurement).
- **Canary first.** Before every run, each tool builds a throwaway repository with one positive
  and one negative sample per check, all generated at runtime. It scans that repository with the
  production code path. If any check misses its positive or fires on its negative, the run stops
  with "could not scan".
- **Fail closed.** Each of these exits 2: not a git repository, 0 tracked files, a tracked file
  missing from the working tree, git without PCRE, a git error, an unparseable event, a failed
  API lookup, an unknown check id, any internal exception.
- **No payload bytes.** Fixtures and canaries are assembled from short inert fragments at runtime.
  The toolkit's own tree scans clean with its own rules (tested).

## Self-test

```
tests/run            # whole suite under C, POSIX and every UTF-8 locale from `locale -a` (minutes)
tests/run NAME ...   # selected cases
bin/self-test        # only the built-in canaries of every P, S and C check (seconds); exit 0 or 2
```

`bin/self-test` is the quick "is the detector working on this machine" step for a pipeline (the
legacy scanner's `.test.sh` step is repointed to it). The scans run the same canaries on their own
before every run; `tests/run` is the full suite (about 6 minutes for 93 cases x 3 locales on a
22-thread WSL host).

Each case builds its own temporary git repository. The suite covers every real variant shape and
every evasion from the phase-1 review, the clean baselines, the allowlist rules, the fail-closed
paths, canary sabotage, P8, all S and C checks, and the action orchestrator. Round 2 added: the
legacy scanner is P1 at any path and the fragment rewrite is not; `tools/adoption-precheck` in
tree and mirror mode; 28 hidden-executor shapes in each of the 8 files the campaign rewrote;
quoted global members; prose comments and their traps; decoders without an executor; escape and
split blobs; yarn/bun/deno lockfiles; 30 run-step shapes plus Amplify; P2/P3 allowlisting in data
files only. Round 3 added: `tools/adoption-patch` on a tree shaped like the clean heads (legacy
literal at line 114, its self-test and `.allow`, security-scan.yml, a release job other jobs
`needs:`, amplify preBuild, an npm script, the mcp-server gate, comment and doc mentions): P1 before,
every check clean after, and the same result from `git apply` of its patch on a fresh clone; what
it must leave to a human (arguments, pipes, path filters, JS callers); a legacy-named file that
carries a real signature (P1 without the legacy hint, flagged SUSPICIOUS, never deleted); the
real-world JSDoc blocks (no P4, no P5) and ten traps that keep the value forms P4; per-rule
P5 titles in the report, the JSON and the `::error` annotation; comment and doc mentions of the
legacy scanner reported apart from steps.

## Adoption pre-check (rollout helper)

```
tools/adoption-precheck --repo-dir DIR [--json FILE] [--allow-draft FILE]
tools/adoption-precheck --mirror REPO.git --refs main,stage,prod --work DIR [--json FILE]
```

Run it on a consuming repository (or on its main/stage/prod heads from a bare mirror; each head is
checked out as a temporary detached worktree under `--work` with hooks disabled, then removed)
before opening the adoption PR. It is read-only and runs nothing from the tree. It lists:

1. the legacy scanner files to delete (`scripts/scan-injected-payload.sh`, its `.test.sh` and
   `.allow`, `scripts/supply-chain-scan.sh`), with the P1 line the legacy scanner trips and the
   fragment form (`'_$''name'`) to use if a file must stay. Only the legacy grep literal itself
   (`-e '_$<sig>'`) counts as "legacy"; any other finding in a file of that name is listed as a
   real finding and the file is marked SUSPICIOUS (it may be a payload wearing the scanner's name);
2. every step that runs them: workflow steps, `amplify.yml` build commands (replace with
   `bash .supply-chain-guard/bin/scan-payload && bash .supply-chain-guard/bin/supply-chain-check`),
   `package.json` scripts, other scripts. Mentions in comments (YAML/shell `#`, JS `//` and JSDoc)
   and in documentation are listed apart: they run nothing and are not adoption work;
3. what still blocks once they are gone: "fix in the PR" (not allowlistable: unpinned `uses:`,
   workflow S6, P1-P3 in code) and "allowlist with a reason" (P4-P7, S1-S5, ...).

`--allow-draft` writes a `.supply-chain-guard.allow` draft whose entries are all commented out:
each needs a human review and a written reason before it is enabled. Exit status: 0 nothing to
change, 1 adoption work required, 2 could not check.

## Adoption patch (rollout helper)

```
tools/adoption-patch --repo-dir DIR [--patch FILE] [--json FILE]
tools/adoption-patch --mirror REPO.git --refs main,stage,prod --work DIR --out DIR [--json FILE]
```

Makes the legacy-scanner part of the adoption PR in a clean working tree (a fresh branch or a
scratch worktree; mirror mode uses temporary detached worktrees and writes `<repo>-<ref>.patch` and
`.txt` per head into `--out`). Nothing is committed; the change is staged and, with `--patch`,
written as a `git apply --index` patch.

1. Deletes the legacy scanner files. A legacy-named file with any finding besides the legacy grep
   literal is kept and reported SUSPICIOUS.
2. Repoints every step that ran them at the local copy, keeping the step (its name, its job, every
   `needs:` on it): `bash scripts/scan-injected-payload.sh` becomes
   `bash .supply-chain-guard/bin/scan-payload && bash .supply-chain-guard/bin/supply-chain-check`,
   and the legacy self-test `bash scripts/scan-injected-payload.test.sh` becomes
   `bash .supply-chain-guard/bin/self-test` (every check's canary, seconds). Workflows, `action.yml`, `amplify.yml`, `package.json`
   scripts, shell scripts, Makefiles and Dockerfiles; a `../` prefix is kept for commands that run
   from a subdirectory.
3. Vendors `.supply-chain-guard/` from this toolkit byte for byte (it names the toolkit commit to
   pin the action to), so P8 in the pinned action passes and fails any later edit of the copy.

It never rewrites what it cannot rewrite safely: an invocation with arguments, inside a pipe,
`||`, `$(...)` or backticks, a call from JS/TS code, or a bare path (a `paths:` filter, a `cp`
argument) is listed as "needs a human". Comments and docs are left alone. Then it re-runs the
pre-check on the changed tree and prints the P1 count and what else still blocks. Exit status: 0
the changed tree passes, 1 the change was made but work remains (or something needs a human, or a
file is suspicious), 2 could not run (a dirty tree, a canary failure, not a git repository).

Requirements: bash, git with PCRE (`git grep -P`), python3 >= 3.7 (stdlib only; `tomllib` used
when present), curl (commit-provenance only).

## Known limits

- Submodules are not scanned; scan them in their own repository.
- Content checks are line-based pattern rules, not a JS parser. Once P1 markers are renamed and
  the padding is dropped, P4/P5 are the content backstop, and JS can always hide an executor
  behind indirection no pattern lists. Not covered today: a string handed to `setTimeout(v)` or
  `import(v)` through a variable whose value is built at run time; code written to a file and then
  `require`d / `import`ed / spawned (`fs.writeFileSync(p, s); require(p)`); `child_process` running
  `node` with code assembled at run time; a hidden executor fed by a decoder in a plain runtime
  file whose encoded body is fetched over the network (no literal, blob or local data file in the
  repo). The decoder rules close the "renamed markers + hidden executor + local encoded body"
  shape; the commit-provenance checks and required reviews are the backstop for the rest.
- Invisible padding made of chars that are not JS whitespace (for example U+2800, U+3164, U+200B)
  is not P2. It is caught only when the same line also trips P1, P3 or P4-P6.
- JS stored under a non-JS extension (`.es6`, `.txt`, `.png`) and loaded explicitly
  (`node x.png`, `require('./x.txt')`) gets P1/P2/P3/P5b only.
- S6 reads `run:` commands and Amplify commands; it does not follow scripts they call
  (`bash scripts/ci.sh`), so `curl | sh` inside a committed shell script is not S6.
- An npm lockfile can omit `hasInstallScript`; S4 reports only what the lockfile declares.
