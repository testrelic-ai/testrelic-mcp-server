"""scan-payload: P1-P8 over every tracked file.

Two stages. (1) `git grep -n -z -a -P` in byte mode (LC_ALL=C) selects candidate LINES with a
union of prefilter patterns; every prefilter is a SUPERSET of the exact rule it feeds, so it can
only add work, never hide a hit. (2) python applies the exact rules to those lines only. Both
stages run on a built-in canary repo first; a check that cannot find its canary fails the run
(exit 2).

The signature strings below are assembled from fragments so this file never matches itself.
"""
import json
import os
import re
import shutil
import tempfile

from . import common as C
from .common import Finding

# ---------------------------------------------------------------------------
# file classes
# ---------------------------------------------------------------------------
JS_EXT = C.JS_EXT
CODE_EXT = JS_EXT | frozenset(("json", "yml", "yaml", "sh", "py"))
LOCKFILES = C.LOCKFILES
# Binary media: blank "padding" inside compressed image/font/archive bytes is noise, not hidden
# code (a real PNG fixture has 16 0x09 bytes in its deflate stream). A file is
# exempt from P2/P2b (and from the data-file P5b rule) only when BOTH its extension is listed
# here AND its content really is binary (a NUL byte or invalid UTF-8). A text file renamed to
# .png is still scanned, and JS/code files are never exempt, whatever bytes they contain.
BINARY_MEDIA_EXT = frozenset((
    "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp", "tif", "tiff", "avif", "heic", "psd",
    "woff", "woff2", "ttf", "otf", "eot", "pdf", "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar",
    "jar", "wasm", "mp3", "mp4", "m4a", "wav", "ogg", "webm", "mov", "avi", "sqlite", "db", "node",
    "so", "dylib", "dll", "exe", "class", "pyc", "keystore", "p12", "der"))


def is_binary_media(path, data):
    if _ext(path) not in BINARY_MEDIA_EXT:
        return False
    if b"\0" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


_RX_SHEBANG_JS = re.compile(rb"\A(?:\xef\xbb\xbf)?#![^\n]*\b(?:node|nodejs|tsx|ts-node|bun|deno|zx)\b")
_RX_SHEBANG_CODE = re.compile(rb"\A(?:\xef\xbb\xbf)?#![^\n]*\b(?:sh|bash|dash|zsh|ksh|python[0-9.]*)\b")


def _ext(path):
    return C.ext_of(path)


def classify(path, head):
    """-> (is_js, is_code_for_P3). Extension decides; extensionless files go by shebang."""
    base = path.rsplit("/", 1)[-1]
    ext = _ext(path)
    is_js = ext in JS_EXT
    is_code = ext in CODE_EXT
    if not ext:
        if _RX_SHEBANG_JS.match(head):
            is_js = is_code = True
        elif _RX_SHEBANG_CODE.match(head):
            is_code = True
    low = base.lower()
    if is_code and (".min." in low or low.endswith(".map") or base in LOCKFILES):
        is_code = False
    return is_js, is_code


# Build/install/config-time files: the places this campaign rewrites (postinstall.cjs,
# mirror-skills.js, esbuild.mjs, postcss.config.mjs, typecheck-gate.mjs, migrate.ts, seed.ts, ...).
# Any decoder in such a file is a P5 finding on its own (see scan_lines).
_BUILD_DIRS = frozenset(("scripts", "script", "tools", "tooling", "bin", "build", "ci", ".ci", ".github", ".husky",
                         "hooks", ".circleci", ".vscode", ".devcontainer", "migrations", "seeds", "seeders"))
_RX_BUILD_BASE = re.compile(
    r"(?i)\A(?:[^/]*[._-])?(?:[^/]*\.config|[^/]*\.conf|\.[^/]*rc|esbuild|webpack|rollup|gulpfile|gruntfile|jakefile"
    r"|(?:pre|post)?install|prepare|prepack|postpack|migrate|migration|seed)"
    r"(?:[._-][^/]*)?\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)\Z")


def is_build_time(path, script_targets, is_js_shebang=False):
    if path in script_targets or is_js_shebang:
        return True
    parts = path.split("/")
    base = parts[-1]
    if any(p.lower() in _BUILD_DIRS for p in parts[:-1]):
        return True
    if len(parts) == 1 and _ext(path) in ("mjs", "cjs"):
        return True
    return bool(_RX_BUILD_BASE.match(base))


_RX_SCRIPT_PATH = re.compile(r"""(?:^|[\s'"=(;&|])((?:\.{1,2}/)?[\w@.$/-]+\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx))(?=$|[\s'");&|])""")


def script_targets(repo):
    """Files any package.json script runs (`node scripts/x.cjs`, `tsx tools/y.ts`, ...)."""
    out = set()
    for path in repo.regular:
        if path.rsplit("/", 1)[-1] != "package.json":
            continue
        try:
            doc = json.loads(repo.read(path).decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            continue
        scripts = doc.get("scripts") if isinstance(doc, dict) else None
        if not isinstance(scripts, dict):
            continue
        pkgdir = path.rsplit("/", 1)[0] if "/" in path else ""
        for cmd in scripts.values():
            if not isinstance(cmd, str):
                continue
            for m in _RX_SCRIPT_PATH.finditer(cmd):
                t = C.norm_rel(pkgdir, m.group(1))
                if t:
                    out.add(t)
    return out


# ---------------------------------------------------------------------------
# patterns (bytes; identical spelling is valid PCRE and python re). `[^\S\n]` = \s minus the
# newline, which keeps every rule inside one line exactly like a line-based git grep.
# ---------------------------------------------------------------------------
WS = rb"[^\S\n]"
Q = rb"['\"\x60]"
NQ = rb"[^'\"\x60\n]"
GLOB = rb"(?:globalThis|window|global|self)"
DOT = rb"(?:\?\.|\.)"
OPTCH = rb"(?:\?\." + WS + rb"*)?"
EV = rb"ev" + rb"al"
FN = rb"Func" + rb"tion"
P1_RX = [
    rb"glo" + rb"bal\.[A-Za-z_$][\w$]*" + WS + rb"*=" + WS + rb"*" + Q + rb"\d+-\d+-[a-z]{2}" + Q,
    rb"_\$" + rb"_[0-9a-f]{4}" + WS + rb"*=",
    rb"_\$" + rb"jso[A-Z][A-Za-z]+",
    rb"dmFyIF8k" + rb"X",
    rb"Z2xvYmFs" + rb"Lm8",
]
PREAMBLE_1 = b"import { create" + b"Require } from 'module';"
PREAMBLE_2 = b"const require = create" + b"Require(import.meta.url);"

DANGER_NAMES = (EV, FN, b"execScript", b"constructor", b"setTimeout", b"setInterval", b"setImmediate", b"require",
                b"runInThisContext", b"runInNewContext", b"runInContext", b"compile" + FN, b"_compile")
_DANGER_ALT = rb"(?:" + rb"|".join(DANGER_NAMES) + rb")"

# P4: (regex, gate tokens). A rule runs on a line only if one of its tokens is in the line, and
# every branch of the rule contains one of them, so a gate can only skip impossible lines.
# `^`/`$` are fine here (python, one line at a time); the prefilter uses PRE versions below.
# 17: eval used as a value: (0, eval)(s), {r: eval}, [eval][0], x = eval;, eval alone on a line
P4_EVAL_VALUE = (rb"(?:^|[(\[,:;{}]|(?<![=!<>])=)" + WS + rb"*" + EV + WS + rb"*(?:[,)\]};]|$)", (EV,))
# 18: Function used as a value (not `instanceof Function`, not `: Function` TS types)
P4_FN_VALUE = (rb"(?:^|[(\[,;{}]|(?<![=!<>])=)" + WS + rb"*" + FN + WS + rb"*(?:[,;\]}]|$)|," + WS + rb"*" + FN + WS
               + rb"*\)", (FN,))
P4_RULES = [
    # 1-11: the v1 rules
    # (a backtick right before a name is a markdown code span in a comment, never a tagged call)
    (rb"\b" + EV + WS + rb"*(?:\?\." + WS + rb"*)?\(", (EV,)),
    (rb"(?<![\w$.\x60])" + FN + WS + rb"*(?:\?\." + WS + rb"*)?[(\x60]", (FN,)),
    (rb"\bnew" + WS + rb"+" + FN + WS + rb"*[(\x60]", (FN,)),
    (FN + WS + rb"*\." + WS + rb"*constructor", (b"constructor",)),
    (rb"(?<!\x60)\bconstructor" + WS + rb"*(?:\?\." + WS + rb"*)?(?:\(" + WS + rb"*" + Q + rb"|\x60)", (b"constructor",)),
    (rb"\[" + WS + rb"*" + Q + rb"constructor" + Q + WS + rb"*\]", (b"constructor",)),
    (rb"\bvm\.runIn\w+", (b"runIn",)),
    (rb"runInThis" + rb"Context|runInNew" + rb"Context|compile" + FN, (b"runIn", b"compile" + FN)),
    (rb"\bset(?:Timeout|Interval)" + WS + rb"*\(" + WS + rb"*" + Q + rb"|(?<!\x60)\bset(?:Timeout|Interval|Immediate)"
     + WS + rb"*\x60", (b"Timeout", b"Interval", b"Immediate")),
    (rb"\bimport" + WS + rb"*\(" + WS + rb"*" + Q + rb"(?:data|blob):", (b"import",)),
    (rb"(?<![\w$.])" + GLOB + WS + rb"*\[" + WS + rb"*" + Q + NQ + rb"*" + Q + WS + rb"*\+", (b"window", b"global", b"self")),
    # 12: a dangerous name as a quoted computed key of ANY member expression: globalThis['eval'],
    #     window["Function"], (function(){return this})()['eval'], x?.['constructor']
    (rb"[\w$)\]]" + WS + rb"*" + OPTCH + rb"\[" + WS + rb"*" + Q + _DANGER_ALT + Q + WS + rb"*\]",
     (EV, FN, b"execScript", b"constructor", b"Timeout", b"Interval", b"Immediate", b"require", b"runIn", b"_compile")),
    # 13: escape sequence or ${} inside a global object's quoted key: globalThis['\x65val']
    (rb"(?<![\w$.])(?:" + GLOB + rb"|this)" + WS + rb"*" + OPTCH + rb"\[" + WS + rb"*" + Q + NQ + rb"*?(?:\\|\$\{)",
     (b"window", b"global", b"self", b"this")),
    # 14: non-literal computed key on a global object: globalThis[k], window[name]
    (rb"(?<![\w$.])" + GLOB + WS + rb"*" + OPTCH + rb"\[" + WS + rb"*(?![\s'\"\x60\d\]])", (b"window", b"global", b"self")),
    # 15: dynamic call through this: this[k](s), this[String.fromCharCode(..)](s)
    (rb"(?<![\w$.])this" + WS + rb"*" + OPTCH + rb"\[" + WS + rb"*(?![\s'\"\x60\d\]])[^\]\n]*\]" + WS + rb"*"
     + OPTCH + rb"\(", (b"this",)),
    # 16: the executor taken as a property of a global object: globalThis.eval, window.Function
    (rb"(?<![\w$.])(?:" + GLOB + rb"|this|top|parent|frames)" + WS + rb"*" + DOT + WS + rb"*(?:" + EV + rb"|" + FN
     + rb"|execScript)\b", (EV, FN, b"execScript")),
    # 17-18: eval / Function used as a value (defined above; see _jsdoc_prose for their one skip)
    P4_EVAL_VALUE,
    P4_FN_VALUE,
    # 19-20: Function reached through constructors: [].constructor.constructor, (()=>{}).constructor
    (rb"\bconstructor" + WS + rb"*" + DOT + WS + rb"*constructor\b|\}" + WS + rb"*\)" + WS + rb"*" + DOT + WS
     + rb"*constructor\b", (b"constructor",)),
    # 21: an executor name handed to a property getter: Reflect.get(globalThis, 'eval'), _.get(w, "Function")
    (rb"," + WS + rb"*" + Q + rb"(?:" + EV + rb"|" + FN + rb"|execScript)" + Q + WS + rb"*\)", (EV, FN, b"execScript")),
    # 22: reflective access to a global object
    (rb"\bReflect" + WS + rb"*" + DOT + WS + rb"*(?:get|apply|construct|getOwnPropertyDescriptor)" + WS + rb"*\("
     + WS + rb"*(?:" + GLOB + rb"|this)\b|\bObject" + WS + rb"*" + DOT + WS + rb"*getOwnPropertyDescriptors?" + WS
     + rb"*\(" + WS + rb"*" + GLOB + rb"\b", (b"Reflect", b"getOwnPropertyDescriptor")),
    # 23: computed key produced by a decoder: obj[String.fromCharCode(..)], o[atob('..')], o[s.reverse()]
    (rb"[\w$)\]]" + WS + rb"*" + OPTCH + rb"\[" + WS + rb"*[^\]\n]*?(?:fromChar" + rb"Code|fromCode" + rb"Point|\bat"
     + rb"ob" + WS + rb"*\(|\bunescape" + WS + rb"*\(|\breverse" + WS + rb"*\(" + WS + rb"*\))",
     (b"fromChar", b"fromCode", b"at" + b"ob", b"unescape", b"reverse")),
    # 24-26: module._compile, Worker with eval: true, node spawned with inline code
    (rb"\._compile" + WS + rb"*\(", (b"_compile",)),
    (rb"\bnew" + WS + rb"+Worker" + WS + rb"*\([^\n]*\b" + EV + WS + rb"*:" + WS + rb"*true\b", (b"Worker",)),
    (rb"(?:\bprocess" + WS + rb"*\." + WS + rb"*execPath|" + Q + rb"node" + Q + rb")[^\n]*" + Q + rb"-(?:e|-" + EV
     + rb"|p|-print)" + Q + rb"|\bexec(?:Sync|File|FileSync)?" + WS + rb"*\(" + WS + rb"*" + Q + WS + rb"*node"
     + WS + rb"+-(?:e|-" + EV + rb"|p|-print)\b", (b"execPath", b"node")),
    # 27: a JavaScript data: URL literal is only good for loading code (import(u), new Worker(u))
    (Q + WS + rb"*data:(?:text|application)/(?:x-)?(?:java|ecma)script\b", (b"data:",)),
]

# Decoders. One combined pattern; the literal-fed variant below decides P5 on its own.
_ENC = rb"(?:base64(?:url)?|hex|latin1|binary|ucs-?2|utf-?16le)"
# decodeURI(Component) counts only when fed a literal of >= 16 %XX escapes; the filler excludes %
# so the repetition stays linear
_DECODE_URI_LIT = (rb"\bdecodeURI(?:Component)?" + WS + rb"*\(" + WS + rb"*" + Q
                   + rb"(?:[^'\"\x60\n%]*%[0-9a-fA-F]{2}){16}")
P5_DECODERS = [
    rb"\bat" + rb"ob" + WS + rb"*(?:\?\." + WS + rb"*)?\(",
    # decoding form: the encoding is Buffer.from's 2nd argument (Buffer.from(x).toString('base64') encodes)
    rb"\bBuffer" + WS + rb"*" + DOT + WS + rb"*from\b[^\n]*?," + WS + rb"*['\"]" + _ENC + rb"['\"]",
    rb"\bnew" + WS + rb"+Buffer" + WS + rb"*\([^\n]*?," + WS + rb"*['\"]" + _ENC + rb"['\"]",
    rb"fromChar" + rb"Code|fromCode" + rb"Point",
    rb"\bTextDecoder\b",
    rb"\bunescape" + WS + rb"*\(",
    rb"\bfrom(?:Base64|Hex)" + WS + rb"*\(",
    rb"\[" + WS + rb"*" + Q + rb"(?:at" + rb"ob|fromChar" + rb"Code|fromCode" + rb"Point|unescape|fromBase64|fromHex)" + Q,
    # a hand-rolled base64 decoder carries the alphabet
    rb"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789(?:\+/|-_)",
    _DECODE_URI_LIT,
]
_P5D_TOKENS = (b"at" + b"ob", b"Buffer", b"fromChar", b"fromCode", b"TextDecoder", b"unescape", b"fromBase64",
               b"fromHex", b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", b"decodeURI")
# decoder applied directly to an inline literal (>= 32 chars) or to >= 8 numeric char codes
_LITFED = re.compile(
    rb"(?:\bat" + rb"ob|\bunescape|\bfrom(?:Base64|Hex)|\bBuffer" + WS + rb"*" + DOT + WS + rb"*from|\bnew" + WS
    + rb"+Buffer)" + WS + rb"*\(" + WS + rb"*(['\"\x60])(?:(?!\1)[^\n\\]|\\.){32,}\1"
    + rb"|fromC(?:har" + rb"Code|ode" + rb"Point)" + WS + rb"*\(" + WS + rb"*(?:(?:0[xX][0-9a-fA-F]+|\d+)" + WS
    + rb"*," + WS + rb"*){7,}(?:0[xX][0-9a-fA-F]+|\d+)"
    + rb"|\bdecode" + WS + rb"*\(" + WS + rb"*(?:new" + WS + rb"+Uint8Array" + WS + rb"*\(" + WS + rb"*)?\[" + WS
    + rb"*(?:(?:0[xX][0-9a-fA-F]+|\d+)" + WS + rb"*," + WS + rb"*){7,}"
    + rb"|" + _DECODE_URI_LIT)
_RX_ALPHABET = re.compile(rb"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789(?:\+/|-_)")
# String.fromCharCode(92): a character constant (<= 7 numeric literals), not a decoder. Executor
# names spelled this way are P4 (_assembled); 8 or more literals are a literal-fed decoder.
_RX_CHAR_CONST = re.compile(rb"fromC(?:har" + rb"Code|ode" + rb"Point)" + WS + rb"*\(" + WS
                            + rb"*(?:(?:0[xX][0-9a-fA-F]+|\d+)" + WS + rb"*," + WS + rb"*){0,6}(?:0[xX][0-9a-fA-F]+|\d+)"
                            + WS + rb"*\)")
# a decoder reached through a quoted computed key (globalThis['atob'], String["fromCharCode"]) is
# obfuscation in itself
_RX_KEYED_DECODER = re.compile(rb"\[" + WS + rb"*" + Q + rb"(?:at" + rb"ob|fromChar" + rb"Code|fromCode" + rb"Point"
                               rb"|unescape|fromBase64|fromHex)" + Q)
# a local data file loaded by the module (the blob moved out of the JS file)
_RX_DATA_IMPORT = re.compile(
    rb"(?:\bfrom" + WS + rb"*|\brequire" + WS + rb"*\(" + WS + rb"*|\bimport" + WS + rb"*\(" + WS + rb"*)" + Q
    + rb"\.{1,2}/" + NQ + rb"{0,1000}?\.(?:json5?|txt|text|dat|bin|b64|base64|data|csv|tsv|raw|enc|blob)" + Q
    + rb"|\breadFile(?:Sync)?" + WS + rb"*\(" + WS + rb"*(?:" + Q + rb"\.{0,2}/|(?:path" + WS + rb"*\." + WS
    + rb"*)?(?:join|resolve)" + WS + rb"*\(" + WS + rb"*(?:__dirname|import\.meta)|new" + WS + rb"+URL" + WS
    + rb"*\(" + WS + rb"*" + Q + rb"\.)")
_DATA_IMPORT_PRE = rb"\.{1,2}/" + NQ + rb"{0,1000}?\.(?:json5?|txt|text|dat|bin|b64|base64|data|csv|tsv|raw|enc|blob)" + Q

P5B_RX = rb"(['\"\x60])[A-Za-z0-9+/]{400,}={0,2}\1"
_CHUNK_RX = re.compile(rb"(['\"\x60])([A-Za-z0-9+/]{48,}={0,2})\1")
_ESC_RX = re.compile(rb"\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]{1,6}\}|[0-7]{1,3})")
_ESC_PRE = rb"\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{|[0-7])"
ESC_BLOB_MIN = 32          # escapes in one literal -> P5b
SPLIT_BLOB_P5 = 400        # >= 3 chunks of >= 48 base64 chars totalling this: a decoder here is P5
SPLIT_BLOB_P5B = 2000      # ... totalling this: every chunk line is P5b on its own

P6_RX = rb"create" + rb"Require" + WS + rb"*\("
P6_ARG_RX = rb"import\.meta\.\w+|\bnew" + WS + rb"+URL" + WS + rb"*\("

# Byte classes covering every UTF-8 byte of every blank char (lead bytes c2 e1 e2 e3 ef plus all
# continuation bytes), so N blank chars always contain >= N consecutive bytes of this class.
_BLANK_BYTES = rb"[\x09\x0b\x0c\x20\x80-\xbf\xc2\xe1\xe2\xe3\xef]"
# Assembly of executor names (python-side check, see _assembled): the prefilter only has to
# select lines with two adjacent string literals joined by +, a join(''), an escape sequence or
# char codes (the last is in P5_DECODERS).
_ASSEMBLY_PRE = [Q + WS + rb"*\+" + WS + rb"*" + Q, rb"\bjoin" + WS + rb"*\(" + WS + rb"*(?:''|\"\"|\x60\x60)", _ESC_PRE]
# NOTE: git grep's look-ahead runs the pattern over the rest of the file buffer, not line by
# line. So no branch may match a newline, and none may use ^ or $ (they would only match at the
# buffer edges).
# Every branch starts with a literal, a word boundary + literal, or a narrow byte class: PCRE2
# then skips impossible start positions with its first-code-unit bitmap. One branch that can start
# anywhere (v1's P3 "line start + 1001-byte look-ahead") makes every byte try every branch: with
# the round-2 rules that cost a large repository 7 s per run instead of 2.
# Each branch is a SUPERSET of the exact rules it feeds:
#  - the word group: every P4 rule, every P5 decoder, P6 and the P1 preamble contain one of these
#    words (eval/atob/reverse as whole words, the others anywhere);
#  - the structural branches: quoted dangerous computed keys, global objects indexed by [],
#    import('data:/blob:'), node spawned with inline code, Buffer decoding forms, blob literals,
#    local data-file imports, string assembly (literal + literal, join(''), escapes);
#  - one run-anchored 40-blank branch: any P2 line (150-run) and any P3 line (40-run) has one.
_PRE_WORDS = (rb"\b" + EV + rb"\b|\bat" + rb"ob\b|\breverse\b|(?:" + FN + rb"|constructor|runIn|execScript|Reflect"
              rb"|getOwnPropertyDescriptor|_compile|Worker|execPath|fromChar" + rb"Code|fromCode" + rb"Point|TextDecoder"
              rb"|unescape|fromBase64|fromHex|decodeURI|readFile|setTimeout|setInterval|setImmediate|create" + rb"Require)"
              rb"|ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
_PRE_STRUCT = [
    rb"\[" + WS + rb"*" + Q + rb"(?:" + rb"|".join(DANGER_NAMES) + rb"|at" + rb"ob|fromChar" + rb"Code|fromCode"
    + rb"Point|unescape|fromBase64|fromHex)" + Q,
    rb"(?:globalThis|window|global|self|this)" + WS + rb"*(?:\?\." + WS + rb"*)?\[",
    rb"\bimport" + WS + rb"*\(" + WS + rb"*" + Q + rb"(?:data|blob):",
    rb"data:(?:text|application)/(?:x-)?(?:java|ecma)script",
    Q + rb"node" + Q,
    rb"\bexec\w*" + WS + rb"*\(" + WS + rb"*" + Q + WS + rb"*node\b",
    P5_DECODERS[1],                                       # Buffer.from(x, '<enc>')
    P5_DECODERS[2],                                       # new Buffer(x, '<enc>')
    rb"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{400}",             # P5b, anchored at the run start (linear)
    Q + rb"[A-Za-z0-9+/]{48}",                            # blob chunks
    _DATA_IMPORT_PRE,
] + _ASSEMBLY_PRE
PREFILTER = (P1_RX + [_PRE_WORDS] + _PRE_STRUCT
             + [rb"(?<!" + _BLANK_BYTES + rb")" + _BLANK_BYTES + rb"{40}",         # P2 (150-run) and P3 (40-run)
                rb"(?<!\x09)\x09{16}"])                                             # P2b
# ONE alternation, never several -e patterns: with N patterns, look-ahead re-scans the whole rest
# of the file with every pattern that has no further hit, once per matching line. That is
# quadratic: a 10 MB file whose every line hits one branch ran for over 16 minutes. One combined
# pattern stops at the next hit, so a file costs one linear pass.
PREFILTER_ONE = b"|".join(b"(?:" + p + b")" for p in PREFILTER)

_P1 = [re.compile(p) for p in P1_RX]
# every _assembled branch needs one of these: literal + literal, join(''), an escape, char codes
_RX_ASSEMBLY_GATE = re.compile(b"|".join(b"(?:" + p + b")" for p in _ASSEMBLY_PRE) + rb"|fromC")
_P4 = [(re.compile(rx), toks) for rx, toks in P4_RULES]
_P4_VALUE_IDX = frozenset((P4_RULES.index(P4_EVAL_VALUE), P4_RULES.index(P4_FN_VALUE)))
_P5D = re.compile(b"|".join(b"(?:" + p + b")" for p in P5_DECODERS))
_P5B = re.compile(P5B_RX)
_P6 = re.compile(P6_RX)
_P6ARG = re.compile(P6_ARG_RX)
# (?<!...) pins every run match to the start of a maximal run, so a crafted line of many
# 149-blank runs cannot make these quadratic.
_RUN150 = re.compile("(?<![%s])[%s]{150,}" % (C.BLANK_CLASS, C.BLANK_CLASS))
_RUN40 = re.compile("(?<![%s])[%s]{40,}" % (C.BLANK_CLASS, C.BLANK_CLASS))
_TAB16 = re.compile("(?<!\t)\t{16,}")

# Gates: literals that every branch of the matching regex must contain (see scan_lines).
_P1_GATED = list(zip([b"glo" + b"bal.", b"_$" + b"_", b"_$" + b"jso", b"dmFyIF8k" + b"X", b"Z2xvYmFs" + b"Lm8"], _P1))
_CREATE_REQUIRE = b"create" + b"Require"
_QUOTES = (b"'", b'"', b"`")
_TAB16_B = b"\t" * 16
# The legacy per-repo scanner (scripts/scan-injected-payload.sh) greps for campaign signatures as
# literal `-e '<sig>'` arguments. That is a P1 finding like any other: no path is exempt and P1 is
# never allowlistable, so the adoption PR deletes the file (tools/adoption-patch does it). The
# hint is attached only when the file has the legacy name AND every P1 match on the line sits
# inside such a quoted -e argument: a payload line planted in a file of that name gets the plain
# P1 message, never "this is the legacy scanner".
_LEGACY_SCANNERS = ("scan-injected-" + "payload", "supply-chain-" + "scan")
_RX_LEGACY_LITERAL = re.compile(rb"(?:\A|[ \t])-e" + WS + rb"*'_\$" + rb"(?:_[0-9a-f]{4}|jso[A-Z][A-Za-z]+)'")


def is_legacy_name(path):
    return any(t in path.rsplit("/", 1)[-1] for t in _LEGACY_SCANNERS)


def legacy_literal_only(lb):
    """True when the line's P1 matches are all legacy-scanner grep literals (`-e '_$<sig>'`)."""
    spans = [m.span() for m in _RX_LEGACY_LITERAL.finditer(lb)]
    if not spans:
        return False
    hit = False
    for rx in _P1:
        for m in rx.finditer(lb):
            hit = True
            if not any(a <= m.start() and m.end() <= b for a, b in spans):
                return False
    return hit


def _gate(lb, toks):
    for t in toks:
        if t in lb:
            return True
    return False


def _ascii_blanks(lb):
    return lb.count(b" ") + lb.count(b"\t") + lb.count(b"\x0b") + lb.count(b"\x0c")


LIFECYCLE = ("preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish",
             "prepublishOnly", "publish", "postpublish", "pnpm:devPreinstall")


def _strip_cr(b):
    return b[:-1] if b.endswith(b"\r") else b


def _blank_followed_by_code(text, end):
    """After a maximal blank run ending at `end` of a single line: is there a non-blank char
    later on the line? A trailing CR (CRLF files) is not code."""
    n = len(text)
    j = end
    while j < n:
        ch = text[j]
        if ch == "\n":
            return False
        if ch == "\r" or ch in C.BLANK_CHARS:
            j += 1
            continue
        return True
    return False


def _kinds(run):
    counts = {}
    for ch in run:
        counts[ch] = counts.get(ch, 0) + 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:4]
    return ", ".join("U+%04X x%d" % (ord(k), v) for k, v in top) + (" ..." if len(counts) > 4 else "")


def _col(lb, off):
    return len(lb[:off].decode("utf-8", "surrogateescape"))


def _comment_only(lb):
    """A line that can hold no executable JS: `// ...` or `/* ... */` alone. Used for P4 only (prose
    such as "eval (LLM evaluation)"). Never skipped: a `{` (JSX expression container, `${}` in a
    template), a `*/` inside a // line (it may close an open block comment) or text after `*/`."""
    s = lb.strip()
    if b"{" in s:
        return False
    if s.startswith(b"//"):
        return b"*/" not in s
    if s.startswith(b"/*"):
        i = s.find(b"*/", 2)
        return i >= 0 and i + 2 == len(s)
    return False


# A JSDoc middle line may name eval/Function as a bare word ("slug among {e2e, unit, eval}."), which
# the value-form rules 17/18 read as `{r: eval}`. A leading `*` can also be a multiplication, so the
# line is not simply skipped. It is prose for 17/18 only when ALL of these hold:
#   - it starts with `*` (not `*/`) and holds none of ( = ? ' " ` \ ${ */
#   - the line above starts with `*` or opens a block comment with `/*`, and has no `*/`;
#   - the line below starts with `*` (another JSDoc line or the closing `*/`).
# Even if such a line were code, it is a multiplication operand on both sides: nothing on it can be
# called (no `(`, no backtick, and the next line starts with `*`), assigned (no `=`), or chosen by
# a ternary (no `?`), so eval/Function is never invoked or stored through it. Every other P4 rule
# still applies to the line, and so does the skip-free P5 decoder logic.
_JSDOC_FORBIDDEN = (b"(", b"=", b"?", b"'", b'"', b"`", b"\\", b"${", b"*/")


def _jsdoc_prose(lb, prev, nxt):
    s = _strip_cr(lb).strip()
    if not s.startswith(b"*") or s.startswith(b"*/") or prev is None or nxt is None:
        return False
    if any(t in s for t in _JSDOC_FORBIDDEN):
        return False
    p = _strip_cr(prev).strip()
    n = _strip_cr(nxt).strip()
    if b"*/" in p or not (p.startswith(b"*") or p.startswith(b"/*")):
        return False
    return n.startswith(b"*")


# ---------------------------------------------------------------------------
# P4 python-side: executor names assembled from pieces
# ---------------------------------------------------------------------------
_ASSEMBLED_DANGER = frozenset(("eval", "Function", "constructor", "execScript", "setTimeout", "setInterval",
                               "setImmediate", "require", "child_process", "runInThisContext", "runInNewContext",
                               "runInContext", "compileFunction", "_compile", "atob", "fromCharCode",
                               "fromCodePoint", "globalThis"))
_RX_STRLIT = re.compile(rb"(['\"\x60])((?:\\.|(?!\1)[^\\\n])*)\1")
_RX_JOIN_EMPTY = re.compile(rb"\." + WS + rb"*join" + WS + rb"*\(" + WS + rb"*(?:''|\"\"|\x60\x60)" + WS + rb"*\)")
_RX_REVERSE_JOIN = re.compile(rb"\." + WS + rb"*reverse" + WS + rb"*\(" + WS + rb"*\)" + WS + rb"*\." + WS
                              + rb"*join" + WS + rb"*\(" + WS + rb"*(?:''|\"\"|\x60\x60)" + WS + rb"*\)")
_RX_SPLIT_EMPTY = re.compile(rb"\." + WS + rb"*split" + WS + rb"*\(" + WS + rb"*(?:''|\"\"|\x60\x60)" + WS + rb"*\)\Z")
_RX_CHARCODES = re.compile(rb"fromC(?:har" + rb"Code|ode" + rb"Point)" + WS + rb"*\(" + WS
                           + rb"*((?:(?:0[xX][0-9a-fA-F]+|\d+)" + WS + rb"*," + WS + rb"*)*(?:0[xX][0-9a-fA-F]+|\d+))"
                           + WS + rb"*\)")
_RX_PLUS_GAP = re.compile(rb"\A" + WS + rb"*\+" + WS + rb"*\Z")
_SIMPLE_ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def _js_unescape(raw):
    """Decode a JS string literal body (bytes). Never raises; undecodable parts stay as is."""
    s = raw.decode("utf-8", "surrogateescape")
    out, i, n = [], 0, len(s)
    while i < n:
        ch = s[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nx = s[i + 1]
        try:
            if nx == "x" and i + 3 < n + 1:
                out.append(chr(int(s[i + 2:i + 4], 16)))
                i += 4
                continue
            if nx == "u" and i + 2 < n and s[i + 2] == "{":
                j = s.index("}", i + 3)
                out.append(chr(int(s[i + 3:j], 16)))
                i = j + 1
                continue
            if nx == "u":
                out.append(chr(int(s[i + 2:i + 6], 16)))
                i += 6
                continue
            if nx in "01234567":
                m = re.match(r"[0-7]{1,3}", s[i + 1:])
                out.append(chr(int(m.group(0), 8)))
                i += 1 + len(m.group(0))
                continue
        except (ValueError, OverflowError):
            pass
        out.append(_SIMPLE_ESC.get(nx, nx))
        i += 2
    return "".join(out)


def _literals(lb):
    """[(start, end, quote, decoded_text, raw_body)] for the string literals of a line (no ${})."""
    res = []
    for m in _RX_STRLIT.finditer(lb):
        body = m.group(2)
        if m.group(1) == b"`" and b"${" in body:
            continue
        res.append((m.start(), m.end(), m.group(1), _js_unescape(body), body))
    return res


def _danger_hit(s):
    t = s.strip()
    if t in _ASSEMBLED_DANGER:
        return t
    return None


def _assembled(lb):
    """(col0, message) when string pieces on this line spell an executor name, else None."""
    lits = _literals(lb)
    # (a) one literal written with escapes: '\x65val', "\u0046unction"
    for st, _en, _q, text, body in lits:
        if b"\\" in body and _ESC_RX.search(body):
            hit = _danger_hit(text)
            if hit:
                return st, "escape-encoded string spells %r" % hit
    # (b) adjacent literals joined by +: 'ev' + 'al', "child_" + "process"
    i = 0
    while i < len(lits):
        j, text = i, lits[i][3]
        while j + 1 < len(lits) and _RX_PLUS_GAP.match(lb[lits[j][1]:lits[j + 1][0]]):
            j += 1
            text += lits[j][3]
        if j > i:
            hit = _danger_hit(text)
            if hit:
                return lits[i][0], "concatenated string spells %r" % hit
            if text.lower().startswith("data:") and b"import" in lb:
                return lits[i][0], "concatenated string builds a data: URL for import()"
        i = j + 1
    # (c) ['ev','al'].join('') / ['la','ve'].reverse().join('')
    for jm in list(_RX_JOIN_EMPTY.finditer(lb)):
        head = lb[:jm.start()]
        rev = False
        rm = re.search(rb"\." + WS + rb"*reverse" + WS + rb"*\(" + WS + rb"*\)" + WS + rb"*\Z", head)
        if rm:
            rev, head = True, head[:rm.start()]
        head = head.rstrip()
        if head.endswith(b"]"):
            depth, k = 0, len(head) - 1
            while k >= 0:
                if head[k:k + 1] == b"]":
                    depth += 1
                elif head[k:k + 1] == b"[":
                    depth -= 1
                    if depth == 0:
                        break
                k -= 1
            if k >= 0:
                inner = [t for (_s, _e, _q, t, _b) in _literals(head[k:])]
                if inner:
                    text = "".join(reversed(inner) if rev else inner)
                    hit = _danger_hit(text) or (rev and _danger_hit("".join(inner)[::-1]))
                    if hit:
                        return k, "array of strings joined to spell %r" % hit
        sm = _RX_SPLIT_EMPTY.search(head)
        if rev and sm:
            lit = [l for l in _literals(head[:sm.start()]) if l[1] == len(head[:sm.start()].rstrip())]
            if lit:
                hit = _danger_hit(lit[0][3][::-1])
                if hit:
                    return lit[0][0], "reversed string spells %r" % hit
    # (d) String.fromCharCode(101,118,97,108)
    for cm in _RX_CHARCODES.finditer(lb):
        try:
            text = "".join(chr(int(x.strip(), 0)) for x in cm.group(1).decode("ascii").split(","))
        except (ValueError, OverflowError):
            continue
        for name in _ASSEMBLED_DANGER:
            if len(name) >= 4 and name in text:
                return cm.start(), "char codes spell %r" % name
    return None


def scan_lines(path, lines, is_js, is_code, pad_checks, checks, emit, build_time=False, data_file=False,
               allowed_exec=frozenset(), read=None):
    """Exact rules over the lines git grep selected: [(lineno, line_bytes_without_LF), ...].
    allowed_exec: fingerprints of this file's P4 lines that the repository allowlists.
    read: () -> the whole file's bytes, used only to look at a candidate line's neighbours."""
    seen = set()
    whole = []

    def neighbours(n):
        if not whole:
            if read is None:
                return None, None
            whole.append(read().split(b"\n"))
        all_lines = whole[0]
        prev = all_lines[n - 2] if 2 <= n <= len(all_lines) + 1 else None
        nxt = all_lines[n] if 0 <= n < len(all_lines) else None
        return prev, nxt

    def add(check, lineno, lb, col0, message, title=None):
        if (check, lineno) in seen:
            return
        seen.add((check, lineno))
        lt = lb.decode("utf-8", "surrogateescape")
        emit(Finding(check, path, lineno, col0 + 1, message, _strip_cr(lb), C.excerpt(lt.rstrip("\r"), col0),
                     title=title))

    pre1 = {}
    pre2 = []
    execs = []
    decoders = []        # (lineno, lb, match)
    chunks = []          # (lineno, lb, col0, length) quoted base64 literals >= 48 chars
    blob_lines = []      # lines with a >= 400 literal or an escape blob (P5 condition)
    litfed = set()
    data_import = None
    alphabet = set()
    keyed = set()
    weak = set()
    legacy = is_legacy_name(path)
    for lineno, lb in lines:
        # Every regex below sits behind a gate: a literal (or length) that EVERY branch of that
        # regex needs, so a gate can only skip lines the regex could never match. The gates keep
        # dense-match files linear and cheap (12k lines of 900 chars: 32 s -> about 1 s).
        if "P1" in checks:
            best = None
            for tok, rx in _P1_GATED:
                if tok in lb:
                    m = rx.search(lb)
                    if m is not None and (best is None or m.start() < best.start()):
                        best = m
            if best is not None:
                msg = "campaign signature %s" % C.esc(best.group(0)[:24])
                if legacy and legacy_literal_only(lb):
                    msg += ("; this is the legacy in-repo scanner's grep literal: delete the scanner (and repoint "
                            "its workflow/amplify steps) in the adoption PR (tools/adoption-patch), or write the "
                            "literal as fragments")
                add("P1", lineno, lb, _col(lb, best.start()), msg)
            if _CREATE_REQUIRE in lb:
                s = lb.strip()
                if s == PREAMBLE_1:
                    pre1[lineno] = lb
                elif s == PREAMBLE_2:
                    pre2.append(lineno)

        want_p2 = "P2" in checks and len(lb) >= 150 and (not lb.isascii() or _ascii_blanks(lb) >= 150)
        want_p2b = "P2b" in checks and _TAB16_B in lb
        if pad_checks and (want_p2 or want_p2b):
            lt = lb.decode("utf-8", "surrogateescape")
            if want_p2:
                for m in _RUN150.finditer(lt):
                    if _blank_followed_by_code(lt, m.end()):
                        add("P2", lineno, lb, m.start(), "%d blank chars (%s) followed by code on the same line"
                            % (len(m.group(0)), _kinds(m.group(0))))
                        break
            if want_p2b:
                for m in _TAB16.finditer(lt):
                    if any((ch not in C.BLANK_CHARS and ch != "\r") for ch in lt[:m.start()]) and \
                            _blank_followed_by_code(lt, m.end()):
                        add("P2b", lineno, lb, m.start(), "%d consecutive tabs mid-line followed by code"
                            % len(m.group(0)))
                        break

        if "P3" in checks and is_code and len(lb) > 1000:
            line = lb.decode("utf-8", "surrogateescape")
            if line.endswith("\r"):
                line = line[:-1]
            if len(line) > 1000:
                for r in _RUN40.finditer(line):
                    if len(line) - r.end() >= 200:
                        add("P3", lineno, lb, r.start(), "line of %d chars with a %d-char blank run followed by "
                            "%d more chars" % (len(line), len(r.group(0)), len(line) - r.end()))
                        break

        if not is_js:
            # data/doc/config files: a single long base64 literal is a blob store (the decoder
            # side lives in a JS file and is P5 there)
            if "P5b" in checks and data_file and len(lb) >= 402 and _gate(lb, _QUOTES):
                m = _P5B.search(lb)
                if m is not None:
                    add("P5b", lineno, lb, _col(lb, m.start()), "quoted base64 literal of %d chars in a data file"
                        % (len(m.group(0)) - 2))
            continue

        if not _comment_only(lb):
            best = None
            vbest = None      # value-form rules 17/18, which have one JSDoc-prose skip
            for i, (rx, toks) in enumerate(_P4):
                if _gate(lb, toks):
                    m = rx.search(lb)
                    if m is None:
                        continue
                    hit = (m.start(), "dynamic code execution %s" % C.esc(m.group(0)[:40]))
                    if i in _P4_VALUE_IDX:
                        if vbest is None or hit[0] < vbest[0]:
                            vbest = hit
                    elif best is None or hit[0] < best[0]:
                        best = hit
            if vbest is not None and best is None and lb.lstrip()[:1] == b"*":
                prev, nxt = neighbours(lineno)
                if _jsdoc_prose(lb, prev, nxt):
                    vbest = None
            if vbest is not None and (best is None or vbest[0] < best[0]):
                best = vbest
            if best is None and _RX_ASSEMBLY_GATE.search(lb):
                best = _assembled(lb)
                if best is not None:
                    best = (best[0], "dynamic code execution: %s" % best[1])
            if best is not None:
                # a reviewed, allowlisted line (prose about "eval", a test's new Function) is not an
                # executor for P5: allowlisting it once must not keep flagging the file's decoders
                if C.sha256_hex(_strip_cr(lb)) not in allowed_exec:
                    execs.append((lineno, lb, best[0]))
                if "P4" in checks:
                    add("P4", lineno, lb, _col(lb, best[0]), best[1])
        if _gate(lb, _P5D_TOKENS):
            d = _P5D.search(lb)
            if d is not None:
                # char constants (String.fromCharCode(92)) are weak: they count next to an executor
                # (the real plaintext payloads decode with them), never on their own
                strong = d
                if b"fromC" in lb:
                    strong = _P5D.search(_RX_CHAR_CONST.sub(lambda cm: b" " * len(cm.group(0)), lb))
                decoders.append((lineno, lb, strong or d))
                if strong is None:
                    weak.add(lineno)
                if _LITFED.search(lb):
                    litfed.add(lineno)
                if _RX_ALPHABET.search(lb):
                    alphabet.add(lineno)
                if _RX_KEYED_DECODER.search(lb):
                    keyed.add(lineno)
        if data_import is None and _gate(lb, (b"./", b"readFile")):
            dm = _RX_DATA_IMPORT.search(lb)
            if dm is not None:
                data_import = lineno
        if _gate(lb, _QUOTES):
            if len(lb) >= 402:
                m = _P5B.search(lb)
                if m is not None:
                    blob_lines.append(lineno)
                    if "P5b" in checks:
                        add("P5b", lineno, lb, _col(lb, m.start()), "quoted base64 literal of %d chars"
                            % (len(m.group(0)) - 2))
            if len(lb) >= 50:
                for cm in _CHUNK_RX.finditer(lb):
                    chunks.append((lineno, lb, cm.start(), len(cm.group(2))))
            if b"\\" in lb:
                for st, _en, _q, _text, body in _literals(lb):
                    if b"\\" in body:
                        nesc = len(_ESC_RX.findall(body))
                        if nesc >= ESC_BLOB_MIN:
                            blob_lines.append(lineno)
                            if "P5b" in checks:
                                add("P5b", lineno, lb, _col(lb, st), "escape-encoded string literal (%d escapes)" % nesc)
                            break
        if "P6" in checks and _CREATE_REQUIRE in lb:
            m = _P6.search(lb)
            if m is not None and _P6ARG.search(lb):
                add("P6", lineno, lb, _col(lb, m.start()), "createRequire with import.meta / new URL (ESM loader bridge)")

    if "P1" in checks:
        for n in pre2:
            if n - 1 in pre1:
                add("P1", n - 1, pre1[n - 1], 0, "injected createRequire preamble pair (lines %d-%d)" % (n - 1, n))
    chunk_total = sum(c[3] for c in chunks)
    if "P5b" in checks and len(chunks) >= 3 and chunk_total >= SPLIT_BLOB_P5B:
        for lineno, lb, col0, _n in chunks:
            add("P5b", lineno, lb, _col(lb, col0), "base64 blob split across %d literals (%d chars in all)"
                % (len(chunks), chunk_total))
    if "P5" in checks and decoders:
        first = decoders[0]
        for lineno, lb, col0 in execs:
            add("P5", lineno, lb, _col(lb, col0), "dynamic execution in a file that decodes data (%s at line %d)"
                % (C.esc(first[2].group(0)[:24]), first[0]))
        blob = bool(blob_lines) or (len(chunks) >= 3 and chunk_total >= SPLIT_BLOB_P5)
        for lineno, lb, d in decoders:
            # (message, title): only the executor branch keeps the generic "decoder + dynamic
            # execution" title; the others need no executor and say what they did find
            why = title = None
            if lineno in alphabet:
                why, title = "hand-rolled base64 decoder (alphabet literal)", "hand-rolled base64 decoder"
            elif lineno in keyed:
                why, title = "decoder reached through a computed key", "decoder behind a computed key"
            elif lineno in litfed:
                why, title = "decoder applied to an inline literal", "decoder fed an inline literal"
            elif execs:
                why = "decoder in a file with dynamic code execution (line %d)" % execs[0][0]
            elif lineno in weak:
                why = None
            elif blob:
                why, title = "decoder in a file that carries encoded blob literals", "decoder next to encoded blobs"
            elif data_import is not None:
                why = "decoder in a file that loads a local data file (line %d)" % data_import
                title = "decoder loading a local data file"
            elif build_time:
                why, title = "decoder in a build/install/config-time file", "decoder in a build/install-time file"
            if why:
                add("P5", lineno, lb, _col(lb, d.start()), "%s: %s" % (why, C.esc(d.group(0)[:24])), title=title)


def _head(repo, path):
    try:
        with open(repo.abspath(path), "rb") as fh:
            return fh.read(256)
    except OSError as e:
        raise C.CouldNotScan("cannot read %s: %s" % (C.esc(path), e.strerror))


# ---------------------------------------------------------------------------
# P7: lifecycle scripts
# ---------------------------------------------------------------------------
def check_package_json(repo, path, emit):
    raw = repo.read(path)
    text = raw.decode("utf-8", "surrogateescape")
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as e:
        emit(Finding("P7", path, 1, 1, "package.json is not valid JSON (%s); its scripts cannot be verified"
                     % C.esc(str(e)[:80]), raw))
        return
    if not isinstance(doc, dict):
        return
    scripts = doc.get("scripts")
    if not isinstance(scripts, dict):
        return
    for name in LIFECYCLE:
        if name not in scripts:
            continue
        cmd = scripts[name]
        cmd_s = cmd if isinstance(cmd, str) else json.dumps(cmd, sort_keys=True)
        m = re.search(r'"%s"\s*:' % re.escape(name), text)
        line, col = C.line_col(text, m.start()) if m else (1, 1)
        emit(Finding("P7", path, line, col, "lifecycle script %r runs at install/publish time" % name,
                     "%s=%s" % (name, cmd_s), C.esc(cmd_s[:120])))


# ---------------------------------------------------------------------------
# P8: local copy integrity
# ---------------------------------------------------------------------------
def _own_files():
    own = {}
    for dirpath, dirnames, filenames in os.walk(C.GUARD_ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__")]
        for fn in filenames:
            if fn.endswith(".pyc"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, C.GUARD_ROOT).replace(os.sep, "/")
            with open(full, "rb") as fh:
                own[rel] = C.sha256_hex(fh.read())
    return own


def check_local_copy(repo, emit):
    pre = C.GUARD_DIR + "/"
    local = [f for f in repo.files if f.startswith(pre)]
    if not local:
        return
    own = _own_files()
    have = set()
    for f in local:
        rel = f[len(pre):]
        have.add(rel)
        if repo.modes[f] not in ("100644", "100755"):
            emit(Finding("P8", f, 1, 1, "local guard copy entry is not a regular file", f))
            continue
        h = C.sha256_hex(repo.read(f))
        if rel not in own:
            emit(Finding("P8", f, 1, 1, "file is not part of the pinned action", f))
        elif own[rel] != h:
            emit(Finding("P8", f, 1, 1, "differs from the pinned action (sha256 %s, action %s)"
                         % (h[:16], own[rel][:16]), f))
    for rel in sorted(own):
        if (rel.startswith("bin/") or rel.startswith("lib/") or rel == "action.yml") and rel not in have:
            emit(Finding("P8", pre + rel, 0, 0, "missing from the local guard copy", pre + rel))


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------
def scan(repo, checks, allow_p4=frozenset()):
    """allow_p4: {(path, fingerprint)} of the repository's P4 allowlist entries (see scan_lines)."""
    findings = []
    emit = findings.append
    content_checks = [c for c in checks if c in ("P1", "P2", "P2b", "P3", "P4", "P5", "P5b", "P6")]
    if content_checks:
        hits = repo.grep_lines([PREFILTER_ONE.decode("ascii")])
        regular = set(repo.regular)
        targets = script_targets(repo) if "P5" in content_checks else set()
        for path in sorted(hits):
            if path not in regular:
                continue
            lines = hits[path]
            head = lines[0][1][:256] if lines[0][0] == 1 else None
            if _ext(path) == "" and head is None:
                head = _head(repo, path)
            is_js, is_code = classify(path, head or b"")
            binary = False
            if _ext(path) in BINARY_MEDIA_EXT and not is_js and not is_code:
                binary = is_binary_media(path, repo.read(path))
            shebang_js = is_js and _ext(path) == ""
            scan_lines(path, lines, is_js, is_code, not binary, content_checks, emit,
                       build_time=is_js and is_build_time(path, targets, shebang_js),
                       data_file=not is_js and not binary,
                       allowed_exec=frozenset(fp for (p, fp) in allow_p4 if p == path),
                       read=lambda p=path: repo.read(p))
    if "P7" in checks:
        for path in repo.regular:
            if path.rsplit("/", 1)[-1] == "package.json":
                check_package_json(repo, path, emit)
    if "P8" in checks:
        check_local_copy(repo, emit)
    for f in findings:
        f.tool = "scan-payload"
    return findings


# ---------------------------------------------------------------------------
# canary: synthesized at runtime, scanned by the same code path, must match exactly
# ---------------------------------------------------------------------------
def _canary_files(sabotage):
    J = "".join
    blanks = [chr(c) for c in sorted(ord(ch) for ch in C.BLANK_CHARS)]
    mixed = J((blanks * 20)[:150])
    files = {}
    exp = {}

    def want(check, path, line):
        exp.setdefault(check, set()).add((path, line))

    p1 = [J(["glo", "bal.o=", "'1-234-ab'", ";"]),
          J(["_$", "_beef = 0;"]),
          J(["x._$", "jsoFoo;"]),
          J(["s='dmFy", "IF8kXzE';"]),
          J(["s='Z2xv", "YmFsLm8';"]),
          PREAMBLE_1.decode(),
          PREAMBLE_2.decode(),
          J(["glo", "bal.o = 5; _$", "_xyz = 1; $json", "Foo; import { create", "Require } from 'module';"]),
          J(["grep -e '_$", "''jsoToArr' -e '_$", "_d692'"])]
    files["canary/p1.txt"] = "\n".join(p1) + "\n"
    for n in (1, 2, 3, 4, 5, 6):
        want("P1", "canary/p1.txt", n)

    p2 = ["a" + " " * 150 + "b",
          "a" + mixed + "b",
          "a" + " " * 149 + "b",
          "a" + " " * 200,
          "a" + " " * 200 + "\r",
          "a" + "⠀" * 200 + "b",
          "a" + "\t" * 16 + "b",
          "\t" * 20 + "b",
          "a" + "\t" * 15 + "b",
          " " * 151 + "lead"]
    files["canary/p2.txt"] = "\n".join(p2) + "\n"
    want("P2", "canary/p2.txt", 1)
    want("P2", "canary/p2.txt", 2)
    want("P2", "canary/p2.txt", 10)
    want("P2b", "canary/p2.txt", 7)
    # binary media is exempt from P2/P2b only when it really is binary
    files["canary/img.png"] = "\x89PNG\r\n\x1a\n\x00\x00a" + "\t" * 16 + "b" + " " * 150 + "c\n"
    files["canary/text.png"] = "x\n" + "a" + " " * 150 + "b\n"
    want("P2", "canary/text.png", 2)

    # "x-" is outside every other prefilter class, so only the blank-run prefilter can select this
    # file; and the hit is not on line 1, proving the prefilter is not anchored to the buffer start
    long_pad = "x-" * 400 + " " * 45 + "y-" * 150
    files["canary/p3.js"] = "const a = 1;\n" + "z-" * 1000 + "\n" + long_pad + "\n"
    files["canary/p3.min.js"] = long_pad + "\n"
    files["canary/p3.md"] = long_pad + "\n"
    want("P3", "canary/p3.js", 3)

    E, F = "ev" + "al", "Func" + "tion"
    p4 = [J([E, "(x);"]),
          J(["const f = ", F, "('return 1');"]),
          J(["const g = new  ", F, "('a', 'b');"]),
          J([F, ".constructor"]),
          J(["x.constructor(", "'return this')"]),
          J(["[]['filter']['constr", "uctor']"]),
          J(["vm.runIn", "Context(c)"]),
          J(["s.runInThis", "Context()"]),
          J(["setTime", "out('x()', 1)"]),
          J(["await import(", "'data:text/javascript,1')"]),
          J(["globalThis['ev'", " + 'al']"]),
          "obj.Function(1); evaluate(1); setTimeout(fn, 1); new URL(x); isFunction(y);",
          J(["globalThis['", E, "'](s);"]),                          # 13
          J(["(0, ", E, ")(s);"]),                                   # 14
          J(["[].constructor.constr", "uctor('x')();"]),             # 15
          J(["Reflect.get(globalThis, '", E, "')(s);"]),             # 16
          J(["const G = (() => {}).constr", "uctor;"]),              # 17
          J(["const o = {r: globalThis.", E, "};"]),                 # 18
          J(["globalThis[k](s);"]),                                  # 19
          J(["const k = 'e' + 'v' + 'a", "l';"]),                    # 20
          J(["// {", E, "(s)}"]),                                    # 21: JSX child, not a comment
          J(["// ", E, " (LLM evaluation) runs nightly"]),           # 22: prose comment
          J(["cache[keys.join(',')] = 1; expect(x).toBeInstanceOf(", F, "); s = {surfaces: ['", E, "']};"]),
          J(["const t = { type: '", E, "', mode: 'x' };"])]          # 24
    files["canary/p4.js"] = "\n".join(p4) + "\n"
    files["canary/p4.txt"] = J([E, "(x);"]) + "\n"
    for n in list(range(1, 12)) + list(range(13, 22)):
        want("P4", "canary/p4.js", n)
    # value-form rules 17/18: bare names in JSDoc prose are skipped (2, 3); a `*` line under code
    # (6) or one that calls (8) is not
    files["canary/jsdoc.ts"] = "\n".join([
        "/**", J([" * slug among {e2e, unit, ", E, "}."]), J([" * kinds {a, ", F, "}"]), " */",
        "const y = 2", J([" * {r: ", E, "};"]), "/**", J([" * (0, ", E, ")(s)"]), " */"]) + "\n"
    want("P4", "canary/jsdoc.ts", 6)
    want("P4", "canary/jsdoc.ts", 8)

    D = "at" + "ob"
    files["canary/p5.js"] = J(["const s = ", D, "(x);\n", E, "(s);\n"])
    files["canary/p5n.js"] = J(["const s = ", D, "(x);\n", "console.log(s);\n"])
    files["canary/p5l.js"] = J(["const s = ", D, "('", "QUJD" * 9, "');\n"])
    files["canary/scripts/p5c.mjs"] = "const s = Buffer.from(d, 'hex').toString();\n"
    want("P4", "canary/p5.js", 2)
    want("P5", "canary/p5.js", 1)
    want("P5", "canary/p5.js", 2)
    want("P5", "canary/p5l.js", 1)
    want("P5", "canary/scripts/p5c.mjs", 1)
    # a decoded computed key is P4; char constants (<= 7 literals) are a decoder only next to an
    # executor (P5 at 1 and 2 here), never on their own (the build-time file below); 8 are
    files["canary/p4d.js"] = J(["this[String.fromChar", "Code(1, 2)](s);\n",
                                "const sep = s.split(String.fromChar", "Code(92));\n",
                                "const t = String.fromChar", "Code(1, 2, 3, 4, 5, 6, 7, 8);\n"])
    files["canary/scripts/charconst.mjs"] = J(["const sep = s.split(String.fromChar", "Code(92));\n"])
    want("P4", "canary/p4d.js", 1)
    for n in (1, 2, 3):
        want("P5", "canary/p4d.js", n)

    files["canary/p5b.ts"] = ('"' + "QUJD" * 100 + '";\n' + '"' + "A" * 399 + '";\n'
                              + "'" + "\\x41" * 32 + "';\n" + "'" + "\\x41" * 31 + "';\n")
    files["canary/blob.json"] = '{"d": "' + "QUJD" * 100 + '"}\n'
    files["canary/p5s.js"] = "".join("'%s',\n" % ("QUJDREVG" * 45) for _ in range(6))
    want("P5b", "canary/p5b.ts", 1)
    want("P5b", "canary/p5b.ts", 3)
    want("P5b", "canary/blob.json", 1)
    for n in range(1, 7):
        want("P5b", "canary/p5s.js", n)

    files["canary/p6.mjs"] = J(["const r = create", "Require(import.meta.url);\n",
                                "const r2 = create", "Require(somePath);\n"])
    want("P6", "canary/p6.mjs", 1)

    files["canary/package.json"] = '{\n  "scripts": {\n    "build": "tsc",\n    "postinstall": "node x.js"\n  }\n}\n'
    want("P7", "canary/package.json", 4)

    if sabotage:
        # test hook: make one check's positive sample disappear -> the canary must fail (never pass)
        for path in [p for (p, _l) in exp.get(sabotage, set())]:
            files[path] = "inert\n"
    return files, exp


def run_canary(checks, sabotage=None):
    """Scan a synthesized repo with the production code path. Returns a list of problems."""
    tmp = tempfile.mkdtemp(prefix="scg-canary-")
    try:
        files, exp = _canary_files(sabotage)
        for rel, content in files.items():
            full = os.path.join(tmp, rel)
            d = os.path.dirname(full)
            if not os.path.isdir(d):
                os.makedirs(d)
            with open(full, "wb") as fh:
                fh.write(content.encode("utf-8", "surrogateescape"))
        # P8: one faithful file and one tampered file in a local copy
        own_action = os.path.join(C.GUARD_ROOT, "action.yml")
        if os.path.isfile(own_action):
            os.makedirs(os.path.join(tmp, C.GUARD_DIR, "bin"))
            shutil.copyfile(own_action, os.path.join(tmp, C.GUARD_DIR, "action.yml"))
            with open(os.path.join(tmp, C.GUARD_DIR, "bin", "scan-payload"), "wb") as fh:
                fh.write(b"#!/bin/sh\nexit 0\n")
        env = C.tool_env()
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        C.run_git(["init", "-q", tmp], cwd=tmp, env=env)
        C.run_git(["add", "-A"], cwd=tmp, env=env)
        repo = C.Repo(tmp, env=env)
        found = scan(repo, checks)
        problems = []
        got = {}
        for f in found:
            got.setdefault(f.check, set()).add((f.path, f.line))
        for check in checks:
            if check == "P8":
                p8 = set(p for (p, _l) in got.get("P8", set()))
                if os.path.isfile(own_action):
                    if C.GUARD_DIR + "/bin/scan-payload" not in p8:
                        problems.append("P8 did not detect a tampered local copy")
                    if C.GUARD_DIR + "/action.yml" in p8:
                        problems.append("P8 flagged a byte-identical local copy")
                continue
            e = exp.get(check, set())
            g = got.get(check, set())
            miss, extra = sorted(e - g), sorted(g - e)
            if miss:
                problems.append("%s missed %d canary sample(s) (first %s:%d)" % (check, len(miss), miss[0][0], miss[0][1]))
            if extra:
                problems.append("%s false positive on %d canary sample(s) (first %s:%d)"
                                % (check, len(extra), extra[0][0], extra[0][1]))
        return problems
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
