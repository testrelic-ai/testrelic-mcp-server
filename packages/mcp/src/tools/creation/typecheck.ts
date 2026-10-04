import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Type-checks one generated test file with a TypeScript that is already
 * installed: the project's own, else a global one.
 *
 * This replaces `npx tsc --noEmit --skipLibCheck <file>`, which failed in three
 * separate ways:
 *
 *  1. TypeScript 6 and 7 refuse file arguments when a tsconfig.json exists in
 *     the working directory or a parent (TS5112), so every file was a FAIL.
 *  2. On Windows `execFile("npx")` cannot spawn at all (ENOENT; `npx.cmd` needs
 *     a shell), so every file was a FAIL on any TypeScript version.
 *  3. With no TypeScript installed, npx does not fail when stdin is not a TTY:
 *     it downloads and runs the registry package literally named `tsc` (a stub,
 *     not the compiler). The hosted image is that case: it ships no TypeScript.
 *
 * So: find the compiler on disk, run it with this Node binary, and never touch
 * the network.
 */

export type DryRunFramework = "playwright" | "cypress" | "jest" | "vitest";

export interface LocatedTypeScript {
  version: string;
  /** Major version, or null when the version string cannot be parsed. */
  major: number | null;
  /** Absolute path of the JavaScript launcher that `tsc` points at. */
  tscPath: string;
}

/** Where to look for a TypeScript outside the project. */
export interface GlobalLookup {
  /** PATH-style list of directories that may hold a `tsc`. */
  path: string;
  /** npm global prefixes, where `npm i -g typescript` puts the package. */
  npmPrefixes: string[];
}

export interface TypeCheckResult {
  /**
   * `unavailable` means there is no verdict on the file: no compiler was found,
   * it could not run, or it did not finish in time.
   */
  status: "pass" | "fail" | "unavailable";
  output: string;
  typescriptVersion?: string;
  /** The compiler printed more than `OUTPUT_LIMIT` characters; `output` holds the first part. */
  truncated?: boolean;
}

/** Each directory from `startDir` up to the filesystem root. */
function ancestors(startDir: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(startDir);
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/** Reads a TypeScript package directory. Null when there is no `tsc` in it to run. */
function readTypeScriptPackage(pkgDir: string, mustBeNamedTypeScript = false): LocatedTypeScript | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      bin?: unknown;
    };
    if (mustBeNamedTypeScript && pkg.name !== "typescript") return null;
    const rel = pkg.bin && typeof pkg.bin === "object" ? (pkg.bin as Record<string, unknown>).tsc : undefined;
    const tscPath = resolve(pkgDir, typeof rel === "string" ? rel : "bin/tsc");
    if (!existsSync(tscPath)) return null;
    const version = typeof pkg.version === "string" ? pkg.version : "unknown";
    const m = /^(\d+)\./.exec(version);
    return { version, major: m ? Number(m[1]) : null, tscPath };
  } catch {
    return null;
  }
}

/**
 * The places a global TypeScript is looked for by default: PATH, and npm's
 * global prefix. `npx tsc` used the prefix, which npm exports to a server it
 * launches. Without that it is guessed: the directory this Node binary is
 * installed under, and on Windows `%APPDATA%\npm` as well.
 */
export function defaultGlobalLookup(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): GlobalLookup {
  const prefixes = [env.npm_config_global_prefix, env.npm_config_prefix];
  if (process.platform === "win32") prefixes.push(env.APPDATA ? join(env.APPDATA, "npm") : undefined, dirname(execPath));
  else prefixes.push(dirname(dirname(execPath)));
  return {
    path: env.PATH ?? "",
    npmPrefixes: [...new Set(prefixes.filter((p): p is string => !!p && isAbsolute(p)))],
  };
}

/**
 * A TypeScript installed outside the project. First a `tsc` on PATH: npm, Yarn
 * and Homebrew link it into the package, and npm on Windows puts `tsc.cmd`
 * beside `node_modules`. Then npm's global folder, whose bin directory need
 * not be on the server's PATH. Wrapper scripts (pnpm, asdf, Volta) are not
 * followed. Only a package named `typescript` counts, which rules out the
 * registry's unrelated `tsc` package.
 */
function locateGlobal(lookup: GlobalLookup): LocatedTypeScript | null {
  const candidates: string[] = [];
  for (const dir of lookup.path.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    if (existsSync(join(dir, "tsc.cmd"))) candidates.push(join(dir, "node_modules", "typescript"));
    try {
      candidates.push(dirname(dirname(realpathSync(join(dir, "tsc")))));
    } catch {
      // No `tsc` in this directory.
    }
  }
  for (const prefix of lookup.npmPrefixes) {
    candidates.push(join(prefix, "lib", "node_modules", "typescript"), join(prefix, "node_modules", "typescript"));
  }
  for (const pkgDir of candidates) {
    const found = readTypeScriptPackage(pkgDir, true);
    if (found) return found;
  }
  return null;
}

/**
 * Finds an installed compiler: `node_modules/typescript` in `startDir` or the
 * nearest parent that has a usable one, then a global install. Filesystem only.
 */
export function locateTypeScript(startDir: string, lookup: GlobalLookup = defaultGlobalLookup()): LocatedTypeScript | null {
  for (const dir of ancestors(startDir)) {
    const found = readTypeScriptPackage(join(dir, "node_modules", "typescript"));
    if (found) return found;
  }
  return locateGlobal(lookup);
}

/** True when `node_modules/@types/<name>` is visible from `startDir`, i.e. where TypeScript's default type roots look. */
export function hasAmbientTypes(startDir: string, name: string): boolean {
  return ancestors(startDir).some((dir) => existsSync(join(dir, "node_modules", "@types", name, "package.json")));
}

/**
 * `*.cy.ts` is always a Cypress spec, whatever the caller says: older clients
 * still send the previous default, "playwright". Otherwise the caller's choice.
 */
export function resolveFramework(file: string, requested?: DryRunFramework): DryRunFramework {
  if (/\.cy\.[cm]?tsx?$/i.test(file)) return "cypress";
  return requested ?? "playwright";
}

/**
 * Which command line a compiler takes:
 *  - `modern`: TypeScript 6 and later.
 *  - `five`: TypeScript 5.x.
 *  - `legacy`: older than 5.0, which does not know the options the others get.
 */
export type Dialect = "legacy" | "five" | "modern";

/** An unparseable version is most likely a current nightly or fork, so it starts as `modern`. */
export function dialectFor(major: number | null): Dialect {
  if (major === null || major >= 6) return "modern";
  return major === 5 ? "five" : "legacy";
}

/**
 * TypeScript 6's module and strict defaults, with the widest target.
 * TypeScript 5 defaults to ES5, CommonJS and non-strict, where `async` needs
 * `@types/node` to find `Promise` and `.at()`, `for..of` over a Map or a
 * default import are errors. Passing the same options to every version from
 * 5.0 removes the differences that came from defaults. What remains is each
 * compiler's own library: a built-in newer than its `lib.esnext` is unknown.
 * Files are checked as ES modules, so `import x = require()` is an error.
 */
const BASELINE = ["--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler", "--esModuleInterop", "--strict"];

/**
 * Compiler arguments for one file. The project's tsconfig.json is never applied.
 *
 * TypeScript 6 changed two things about this command line, and both are undone:
 *  - `--ignoreConfig`: file arguments next to a tsconfig.json became an error
 *    (TS5112) instead of the config simply being ignored.
 *  - `--types *`: `types` defaults to [] instead of every visible `@types/*`
 *    package, which loses Jest's globals and Node's `process`.
 *
 * Cypress is the exception on every version. Its globals (`cy`, and Mocha's
 * `describe`/`it`) ship in the `cypress` package, not under `@types`, so they
 * were never loaded and no Cypress spec could pass. Naming them explicitly is
 * also the isolation Cypress recommends, since they clash with Jest's.
 *
 * `--pretty false` keeps the diagnostics in the plain `file(line,col): error
 * TSnnnn:` form. With FORCE_COLOR set, TypeScript 6 and 7 colour them even on
 * a pipe, and the result is read from that text.
 */
export function buildTscArgs(opts: {
  file: string;
  framework: DryRunFramework;
  dialect: Dialect;
  nodeTypes: boolean;
}): string[] {
  const args = ["--noEmit", "--skipLibCheck", "--pretty", "false"];
  if (opts.dialect !== "legacy") args.push(...BASELINE);
  if (opts.dialect === "modern") args.push("--ignoreConfig");
  if (opts.framework === "cypress") {
    args.push("--types", opts.nodeTypes ? "cypress,node" : "cypress");
  } else if (opts.dialect === "modern") {
    args.push("--types", "*");
  }
  args.push(opts.file);
  return args;
}

/** Characters of compiler output kept. The first errors are what the agent acts on. */
export const OUTPUT_LIMIT = 32_000;

interface TscRun {
  /** Exit code. Null when the compiler did not exit by itself. */
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Stops the compiler and whatever it started. TypeScript 7's launcher hands
 * over to a native binary that keeps running after SIGTERM, and where it runs
 * that binary as a child, killing the launcher alone would leave it behind.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // taskkill has to find the launcher alive to walk its tree, so the
      // launcher's own kill comes after it, whatever taskkill managed.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        .on("error", () => child.kill())
        .on("exit", () => child.kill());
    } else {
      // The child leads its own process group (`detached` below).
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function runTsc(tscPath: string, args: string[], cwd: string, timeoutMs: number): Promise<TscRun> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, stdout, stderr, truncated, timedOut });
    };
    // Past the limit the output is still read, so a noisy compile ends with
    // its real exit code instead of blocking on a full pipe.
    const keep = (kept: string, chunk: string): string => {
      const room = OUTPUT_LIMIT - kept.length;
      if (chunk.length > room) truncated = true;
      return room > 0 ? kept + chunk.slice(0, room) : kept;
    };
    const failedToStart = (err: unknown) => {
      stderr = keep(stderr, err instanceof Error ? err.message : String(err));
      settle(null, false);
    };

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [tscPath, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        // Inside an Electron host (the VS Code extension runs this server
        // in-process) execPath is the editor's binary; this makes it act as Node.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    } catch (err) {
      failedToStart(err);
      return;
    }
    // Attached before anything else: a spawn that fails (no such binary, no
    // file descriptors left) reports it here, and comes without its streams.
    child.on("error", failedToStart);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout = keep(stdout, chunk)));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr = keep(stderr, chunk)));
    child.on("close", (code, signal) => {
      if (code === null && signal) stderr = keep(stderr, `\nThe compiler was stopped by ${signal}.`);
      settle(code, false);
    });

    timer = setTimeout(
      () => {
        killTree(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(null, true);
      },
      // setTimeout runs a delay above 2^31-1 ms after 1 ms.
      Math.min(timeoutMs, 2_147_483_647),
    );
  });
}

// A command-line error is the first thing the compiler prints. Matching only
// there means a diagnostic that quotes one of these codes, or a file name with
// a line break in it, cannot be mistaken for one.
/** The compiler does not know the TypeScript 6+ flag. */
const REJECTS_IGNORE_CONFIG = /^error TS5023:.*--ignoreConfig/;
/** The compiler wants the TypeScript 6+ flag. */
const WANTS_IGNORE_CONFIG = /^error TS5112:/;
/** Any diagnostic at all: the compiler ran and had something to say. */
const DIAGNOSTIC = /error TS\d+:/;

/** The dialect to retry with when the compiler's own error says the version number picked the wrong one. */
function correctedDialect(dialect: Dialect, run: TscRun): Dialect | null {
  if (run.code === 0 || run.timedOut) return null;
  const head = `${run.stdout}${run.stderr}`.trimStart();
  if (dialect === "modern") return REJECTS_IGNORE_CONFIG.test(head) ? "five" : null;
  return WANTS_IGNORE_CONFIG.test(head) ? "modern" : null;
}

export async function typeCheckFile(opts: {
  file: string;
  /** Project root: where TypeScript is looked up first and where `tsc` runs. */
  cwd: string;
  framework: DryRunFramework;
  timeoutMs: number;
  /** Where to look for a TypeScript outside the project. Defaults to PATH and npm's global prefix. */
  lookup?: GlobalLookup;
}): Promise<TypeCheckResult> {
  const ts = locateTypeScript(opts.cwd, opts.lookup);
  if (!ts) {
    return {
      status: "unavailable",
      output: [
        `TypeScript was not found, so the file was not type-checked. Looked for node_modules/typescript in ${resolve(opts.cwd)} and its parent directories, then for a global install (a \`tsc\` on PATH that links into the \`typescript\` package, or npm's global folder; version-manager wrapper scripts are not followed).`,
        "This check runs a TypeScript that is already installed and never downloads one. Install it in the project (`npm i -D typescript`) and make sure the MCP server is started in the project directory.",
        "The hosted server has no TypeScript and none of your project's dependencies: type-check the file in your own checkout instead.",
      ].join("\n"),
    };
  }

  const nodeTypes = hasAmbientTypes(opts.cwd, "node");
  const runAs = (dialect: Dialect) =>
    runTsc(ts.tscPath, buildTscArgs({ file: opts.file, framework: opts.framework, dialect, nodeTypes }), opts.cwd, opts.timeoutMs);

  // The version decides the dialect. Pre-releases, nightlies and forks can
  // disagree with their version number, so the compiler may correct it, once.
  const dialect = dialectFor(ts.major);
  let run = await runAs(dialect);
  const corrected = correctedDialect(dialect, run);
  if (corrected) run = await runAs(corrected);

  const printed = `${run.stdout}${run.stderr}`.trim();
  const truncated = run.truncated || printed.length > OUTPUT_LIMIT;
  const result = (status: TypeCheckResult["status"], output: string): TypeCheckResult => ({
    status,
    output: output.slice(0, OUTPUT_LIMIT),
    typescriptVersion: ts.version,
    ...(truncated ? { truncated } : {}),
  });

  if (run.code === 0) return result("pass", printed);
  if (run.timedOut) {
    return result("unavailable", `TypeScript ${ts.version} did not finish within ${opts.timeoutMs} ms, so there is no verdict on the file.`);
  }
  // No diagnostic means the compiler itself failed (a crashing launcher, a
  // missing platform package), which says nothing about the file.
  if (!DIAGNOSTIC.test(printed)) {
    return result("unavailable", `TypeScript ${ts.version} could not be run, so the file was not type-checked:\n${printed || "(no output)"}`);
  }
  return result("fail", printed);
}

/** The tool result for one check: markdown for the agent, plus the structured form. */
export function formatDryRun(check: TypeCheckResult, file: string): { text: string; structured: Record<string, unknown> } {
  const ok = check.status === "pass";
  const results = [{ step: "tsc --noEmit", ok, output: check.output }];
  const verdict = { pass: "PASS", fail: "FAIL", unavailable: "NO VERDICT" }[check.status];
  const mark = { pass: "✅", fail: "❌", unavailable: "⚠️" }[check.status];
  const text = [
    `## Dry-run: ${verdict}`,
    ...results.flatMap((r) => ["", `### ${r.step}: ${mark}`, "```", r.output.slice(0, 2_000), "```"]),
  ].join("\n");
  return {
    text,
    structured: {
      ok,
      // `unavailable` = no verdict; `ok: false` then says nothing about the file.
      status: check.status,
      results,
      file,
      ...(check.typescriptVersion ? { typescript_version: check.typescriptVersion } : {}),
      ...(check.truncated ? { truncated: true } : {}),
    },
  };
}
