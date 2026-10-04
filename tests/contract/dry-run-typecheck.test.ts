import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OUTPUT_LIMIT,
  buildTscArgs,
  defaultGlobalLookup,
  dialectFor,
  formatDryRun,
  hasAmbientTypes,
  locateTypeScript,
  resolveFramework,
  typeCheckFile,
  type GlobalLookup,
} from "../../packages/mcp/src/tools/creation/typecheck.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import type { ToolContext } from "../../packages/mcp/src/registry/index.js";
import { startInProcessServer } from "../fixtures/server.js";

/**
 * Regression: `tr_dry_run_test` ran `npx tsc --noEmit --skipLibCheck <file>` and
 * returned FAIL for every file in three situations:
 *
 *  - TypeScript 6 and 7: file arguments next to a tsconfig.json are an error
 *    (TS5112), and `types` no longer defaults to every `@types/*` package.
 *  - Windows: `execFile("npx")` cannot spawn (ENOENT).
 *  - No TypeScript installed (the hosted image): npx fetched and ran the
 *    registry package named `tsc`, a stub that prints an error and exits 1.
 *
 * Cypress specs additionally never passed on any version, because Cypress's
 * globals are not under `@types`.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const POSIX = process.platform !== "win32";
/** No global install: a TypeScript on the machine running the tests cannot leak in. */
const NONE: GlobalLookup = { path: "", npmPrefixes: [] };
/** False on a machine with a TypeScript installed above the temp directory, where "none installed" cannot be staged. */
const NOTHING_ABOVE_TMP = locateTypeScript(tmpdir(), NONE) === null;
/** The arguments every compiler gets, and the options every compiler from 5.0 on gets. */
const COMMON = ["--noEmit", "--skipLibCheck", "--pretty", "false"];
const BASELINE = ["--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler", "--esModuleInterop", "--strict"];

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  // realpath: the lookup resolves symlinks, and macOS's temp directory is one.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tr-dryrun-")));
  scratch.push(dir);
  return dir;
}

/** A scratch directory inside this repo, for the cases that need one (git ignores node_modules). */
function repoTempDir(): string {
  const dir = mkdtempSync(join(repoRoot, "node_modules", ".tr-dry-run-"));
  scratch.push(dir);
  return dir;
}

/** Writes a scripted stand-in for the compiler as an installed package. */
function writeCompiler(pkgDir: string, version: string, tscSource: string, name = "typescript"): void {
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version, bin: { tsc: "./bin/tsc" } }));
  writeFileSync(join(pkgDir, "bin", "tsc"), tscSource);
}

/** A project whose `node_modules/typescript` is a scripted compiler. */
function projectWithCompiler(version: string, tscSource: string, opts: { nodeTypes?: boolean } = {}): string {
  const dir = tempDir();
  writeCompiler(join(dir, "node_modules", "typescript"), version, tscSource);
  if (opts.nodeTypes) {
    mkdirSync(join(dir, "node_modules", "@types", "node"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "@types", "node", "package.json"), "{}");
  }
  return dir;
}

/** An npm-style global install on POSIX: `<prefix>/bin/tsc` links into `<prefix>/lib/node_modules/<name>`. */
function globalInstall(version: string, tscSource: string, name = "typescript"): { prefix: string; binDir: string; pkgDir: string } {
  const prefix = tempDir();
  const pkgDir = join(prefix, "lib", "node_modules", name);
  writeCompiler(pkgDir, version, tscSource, name);
  mkdirSync(join(prefix, "bin"));
  if (POSIX) symlinkSync(join("..", "lib", "node_modules", name, "bin", "tsc"), join(prefix, "bin", "tsc"));
  return { prefix, binDir: join(prefix, "bin"), pkgDir };
}

/** Each scripted compiler appends to `calls.log` in its working directory, once per run. */
const LOG_CALL = `require("node:fs").appendFileSync("calls.log", "run;");`;

function calls(cwd: string): number {
  return readFileSync(join(cwd, "calls.log"), "utf8").split(";").length - 1;
}

/** Behaves like TypeScript 6+: refuses file arguments unless `--ignoreConfig` is given. */
const MODERN_COMPILER = `
${LOG_CALL}
const args = process.argv.slice(2);
if (!args.includes("--ignoreConfig")) {
  console.log("error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.");
  process.exit(1);
}
console.log("ARGS " + JSON.stringify(args));
`;

/** Behaves like TypeScript 5: does not know `--ignoreConfig`. */
const TS5_COMPILER = `
${LOG_CALL}
const args = process.argv.slice(2);
if (args.includes("--ignoreConfig")) {
  console.log("error TS5023: Unknown compiler option '--ignoreConfig'.");
  process.exit(1);
}
console.log("ARGS " + JSON.stringify(args));
`;

const FAILING_COMPILER = `
console.log("gen/x.spec.ts(5,11): error TS2322: Type 'string' is not assignable to type 'number'.");
process.exitCode = 2;
`;

/** A real type error whose message happens to quote the command-line error codes the retry looks for. */
const QUOTING_COMPILER = `
${LOG_CALL}
console.log("gen/x.spec.ts(1,7): error TS2322: Type '\\"error TS5112: x\\"' is not assignable to type 'number'.");
console.log("gen/x.spec.ts(2,7): error TS2322: Type '\\"error TS5023: --ignoreConfig\\"' is not assignable to type 'number'.");
process.exitCode = 2;
`;

/** What a file name containing a line break produces: the codes at the start of a line, but not of the output. */
const FORGING_COMPILER = `
${LOG_CALL}
console.log("gen/a");
console.log("error TS5112: z.spec.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
console.log("error TS5023: Unknown compiler option '--ignoreConfig'.");
process.exitCode = 2;
`;

const PLAIN_DIAGNOSTIC = "gen/x.spec.ts(5,14): error TS2551: Property 'gotoo' does not exist on type 'Page'.";
/** Like TypeScript 6 and 7 with FORCE_COLOR set: coloured diagnostics, even on a pipe, unless told `--pretty false`. */
const COLOURED_COMPILER = `
const args = process.argv.slice(2);
const plain = args.includes("--pretty") && args[args.indexOf("--pretty") + 1] === "false";
console.log(plain
  ? ${JSON.stringify(PLAIN_DIAGNOSTIC)}
  : "\\u001b[96mgen/x.spec.ts\\u001b[0m:5:14 - \\u001b[91merror\\u001b[0m\\u001b[90m TS2551: \\u001b[0mProperty 'gotoo' does not exist on type 'Page'.");
process.exitCode = 2;
`;

const ENV_COMPILER = `console.log("ELECTRON_RUN_AS_NODE=" + process.env.ELECTRON_RUN_AS_NODE);`;

// The stand-ins below would outlive a failing test, so none of them runs for more than 30 s.

/** Like TypeScript 7's native compiler, it does not stop on SIGTERM. */
const STUBBORN_COMPILER = `
require("node:fs").writeFileSync("compiler.pid", String(process.pid));
process.on("SIGTERM", () => {});
setTimeout(() => {}, 30_000);
`;

/**
 * Like TypeScript 7's launcher where it cannot exec: the compiler is a child of
 * the process that was started. The child is `idle.js`, written beside it.
 */
const PARENT_OF_COMPILER = `
const idle = require("node:path").join(__dirname, "idle.js");
const child = require("node:child_process").spawn(process.execPath, [idle], { stdio: "inherit" });
require("node:fs").writeFileSync("grandchild.pid", String(child.pid));
setTimeout(() => {}, 30_000);
`;
const IDLE = `setTimeout(() => {}, 30_000);`;

/** TypeScript 7 installed without the native package for this platform. */
const CRASHING_COMPILER = `throw new Error("Unable to resolve @typescript/typescript-linux-x64. Either your platform is unsupported, or you are missing the package on disk.");`;

const SELF_KILLING_COMPILER = `
process.kill(process.pid, "SIGKILL");
setTimeout(() => {}, 5_000);
`;

const DIAGNOSTIC_LINE = "gen/x.spec.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.";
const NOISY_COMPILER = `
for (let i = 0; i < 4000; i++) console.log(${JSON.stringify(DIAGNOSTIC_LINE)});
process.exitCode = 2;
`;

function argsOf(output: string): string[] {
  return JSON.parse(output.replace(/^ARGS /, "")) as string[];
}

const check = (cwd: string, framework: "playwright" | "cypress" | "jest" | "vitest" = "playwright", timeoutMs = 20_000) =>
  typeCheckFile({ file: join(cwd, "gen", "x.spec.ts"), cwd, framework, timeoutMs, lookup: NONE });

/** Whether a process is still running. A zombie (killed, not yet reaped) counts as gone. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** Waits for the process whose id a stand-in wrote to `<cwd>/<name>` to be gone. True when it is. */
async function isGone(cwd: string, name: string): Promise<boolean> {
  const pid = Number(readFileSync(join(cwd, name), "utf8"));
  const deadline = Date.now() + 10_000;
  while (isRunning(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !isRunning(pid);
}

describe("locateTypeScript", () => {
  it("finds the nearest node_modules/typescript from a nested directory", () => {
    const outer = projectWithCompiler("5.9.3", TS5_COMPILER);
    const nested = join(outer, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    const found = locateTypeScript(nested, NONE);
    expect(found).toMatchObject({ version: "5.9.3", major: 5 });
    expect(found!.tscPath).toBe(join(outer, "node_modules", "typescript", "bin", "tsc"));
  });

  it("prefers a nearer install over one further up", () => {
    const outer = projectWithCompiler("5.9.3", TS5_COMPILER);
    const inner = join(outer, "packages", "app");
    writeCompiler(join(inner, "node_modules", "typescript"), "7.0.2", MODERN_COMPILER);
    expect(locateTypeScript(inner, NONE)).toMatchObject({ version: "7.0.2", major: 7 });
  });

  it("parses pre-release and nightly versions, and reports null for an unparseable one", () => {
    for (const [version, major] of [["6.0.0-beta", 6], ["7.1.0-dev.20261004.1", 7], ["nightly", null]] as const) {
      expect(locateTypeScript(projectWithCompiler(version, TS5_COMPILER), NONE)?.major).toBe(major);
    }
  });

  it("skips an install that has no launcher and uses the one further up", () => {
    const outer = projectWithCompiler("5.9.3", TS5_COMPILER);
    const inner = join(outer, "packages", "app");
    mkdirSync(join(inner, "node_modules", "typescript"), { recursive: true });
    writeFileSync(join(inner, "node_modules", "typescript", "package.json"), JSON.stringify({ version: "7.0.2", bin: { tsc: "./bin/tsc" } }));
    expect(locateTypeScript(inner, NONE)).toMatchObject({ version: "5.9.3" });
  });

  it.skipIf(!NOTHING_ABOVE_TMP)("returns null when the only install has no launcher", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", "typescript"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "typescript", "package.json"), JSON.stringify({ version: "7.0.2", bin: { tsc: "./bin/tsc" } }));
    expect(locateTypeScript(dir, NONE)).toBeNull();
  });
});

describe("locateTypeScript, outside the project", () => {
  it.skipIf(!POSIX || !NOTHING_ABOVE_TMP)("falls back to a `tsc` on PATH that links into the typescript package", () => {
    const { binDir, pkgDir } = globalInstall("5.9.3", TS5_COMPILER);
    const path = ["", join(tempDir(), "missing"), binDir].join(delimiter);
    expect(locateTypeScript(tempDir(), { path, npmPrefixes: [] })).toEqual({ version: "5.9.3", major: 5, tscPath: join(pkgDir, "bin", "tsc") });
  });

  it.skipIf(!NOTHING_ABOVE_TMP)("falls back to npm's Windows layout on PATH: `tsc.cmd` beside node_modules", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "tsc.cmd"), "@echo off\r\n");
    writeCompiler(join(dir, "node_modules", "typescript"), "6.0.3", MODERN_COMPILER);
    expect(locateTypeScript(tempDir(), { path: dir, npmPrefixes: [] })).toMatchObject({ version: "6.0.3", major: 6 });
  });

  it.skipIf(!NOTHING_ABOVE_TMP)("ignores a relative PATH entry, which would be read against the working directory", () => {
    // Staged inside the repo so the same directory can also be named relative to the working directory.
    const dir = repoTempDir();
    writeFileSync(join(dir, "tsc.cmd"), "@echo off\r\n");
    writeCompiler(join(dir, "node_modules", "typescript"), "6.0.3", MODERN_COMPILER);
    expect(locateTypeScript(tempDir(), { path: dir, npmPrefixes: [] })).toMatchObject({ version: "6.0.3" });
    expect(locateTypeScript(tempDir(), { path: relative(process.cwd(), dir), npmPrefixes: [] })).toBeNull();
  });

  it.skipIf(!NOTHING_ABOVE_TMP)("falls back to npm's global folder when its bin directory is not on PATH", () => {
    // `npx tsc` found this one through npm's prefix, not through PATH.
    const { prefix, pkgDir } = globalInstall("5.9.3", TS5_COMPILER);
    expect(locateTypeScript(tempDir(), { path: "", npmPrefixes: [prefix] })).toMatchObject({ version: "5.9.3", tscPath: join(pkgDir, "bin", "tsc") });

    const windowsPrefix = tempDir();
    writeCompiler(join(windowsPrefix, "node_modules", "typescript"), "7.0.2", MODERN_COMPILER);
    expect(locateTypeScript(tempDir(), { path: "", npmPrefixes: [windowsPrefix] })).toMatchObject({ version: "7.0.2" });
  });

  it.skipIf(!NOTHING_ABOVE_TMP)("ignores a global `tsc` that is not TypeScript (the registry's `tsc` package)", () => {
    const stub = `console.log("This is not the tsc command you are looking for"); process.exit(1);`;
    const { prefix, binDir } = globalInstall("2.0.4", stub, "tsc");
    expect(locateTypeScript(tempDir(), { path: binDir, npmPrefixes: [prefix] })).toBeNull();

    const renamed = tempDir();
    writeCompiler(join(renamed, "lib", "node_modules", "typescript"), "2.0.4", stub, "tsc");
    expect(locateTypeScript(tempDir(), { path: "", npmPrefixes: [renamed] })).toBeNull();
  });

  it("prefers the project's install over a global one", () => {
    const { prefix, binDir } = globalInstall("5.9.3", TS5_COMPILER);
    const lookup = { path: binDir, npmPrefixes: [prefix] };
    expect(locateTypeScript(projectWithCompiler("7.0.2", MODERN_COMPILER), lookup)).toMatchObject({ version: "7.0.2" });
  });

  it("looks in PATH, the prefix npm exports, and the Node installation's own prefix by default", () => {
    const ownPrefix = POSIX ? "/opt/node" : dirname("/opt/node/bin/node");
    const env = { PATH: `/a${delimiter}/b`, npm_config_global_prefix: "/opt/npm", npm_config_prefix: "/opt/npm" };
    const lookup = defaultGlobalLookup(env, "/opt/node/bin/node");
    expect(lookup.path).toBe(`/a${delimiter}/b`);
    expect(lookup.npmPrefixes).toEqual(["/opt/npm", ownPrefix]);

    const bare = defaultGlobalLookup({ npm_config_global_prefix: "", npm_config_prefix: "relative/prefix" }, "/opt/node/bin/node");
    expect(bare).toEqual({ path: "", npmPrefixes: [ownPrefix] });
  });
});

describe("resolveFramework", () => {
  it("treats `*.cy.ts` as Cypress whatever the caller sent, and otherwise takes the caller's choice", () => {
    expect(resolveFramework("/out/generated/generated-J1.cy.ts")).toBe("cypress");
    expect(resolveFramework("C:\\out\\generated\\Login.CY.tsx")).toBe("cypress");
    // Clients that cached the old schema still send its default.
    expect(resolveFramework("/out/generated/generated-J1.cy.ts", "playwright")).toBe("cypress");
    expect(resolveFramework("/out/generated/checkout.spec.ts", "cypress")).toBe("cypress");
    expect(resolveFramework("/out/generated/a.test.ts", "jest")).toBe("jest");
    for (const other of ["/out/generated/a.spec.ts", "/out/generated/a.test.ts", "/out/cy.ts", "/out/a.cy.ts.bak"]) {
      expect(resolveFramework(other)).toBe("playwright");
    }
  });
});

describe("buildTscArgs", () => {
  const file = "/out/generated/x.spec.ts";

  it("picks the command line from the major version", () => {
    expect([4, 5, 6, 7, 8, null].map(dialectFor)).toEqual(["legacy", "five", "modern", "modern", "modern", "modern"]);
  });

  it("gives TypeScript 5 the same explicit options as 6 and 7, without the 6+ flags", () => {
    for (const framework of ["playwright", "vitest", "jest"] as const) {
      expect(buildTscArgs({ file, framework, dialect: "five", nodeTypes: true })).toEqual([...COMMON, ...BASELINE, file]);
    }
  });

  it("adds --ignoreConfig and --types * on TypeScript 6+ (the defaults that changed)", () => {
    expect(buildTscArgs({ file, framework: "jest", dialect: "modern", nodeTypes: true })).toEqual([
      ...COMMON,
      ...BASELINE,
      "--ignoreConfig",
      "--types",
      "*",
      file,
    ]);
  });

  it("gives TypeScript older than 5.0 no options it does not know", () => {
    expect(buildTscArgs({ file, framework: "playwright", dialect: "legacy", nodeTypes: true })).toEqual([...COMMON, file]);
  });

  it("names Cypress's types explicitly on every version, with node only when installed", () => {
    const types = (dialect: "legacy" | "five" | "modern", nodeTypes: boolean) => {
      const args = buildTscArgs({ file, framework: "cypress", dialect, nodeTypes });
      return args.slice(args.indexOf("--types"), args.indexOf("--types") + 2);
    };
    for (const dialect of ["legacy", "five", "modern"] as const) {
      expect(types(dialect, true)).toEqual(["--types", "cypress,node"]);
      expect(types(dialect, false)).toEqual(["--types", "cypress"]);
    }
    expect(buildTscArgs({ file, framework: "cypress", dialect: "modern", nodeTypes: true })).not.toContain("*");
  });

  it("always puts the file last, after every option", () => {
    for (const dialect of ["legacy", "five", "modern"] as const) {
      expect(buildTscArgs({ file, framework: "cypress", dialect, nodeTypes: true }).at(-1)).toBe(file);
    }
  });
});

describe("typeCheckFile launcher", () => {
  it("passes on TypeScript 7, which refused every file next to a tsconfig.json (TS5112)", async () => {
    const cwd = projectWithCompiler("7.0.2", MODERN_COMPILER);
    const res = await check(cwd);
    expect(res.status).toBe("pass");
    expect(res.typescriptVersion).toBe("7.0.2");
    expect(argsOf(res.output)).toEqual([...COMMON, ...BASELINE, "--ignoreConfig", "--types", "*", join(cwd, "gen", "x.spec.ts")]);
    // The version picks the right flags first time; the retry is only for compilers that disagree with it.
    expect(calls(cwd)).toBe(1);
  });

  it("runs TypeScript 5 once, without the flags it does not know", async () => {
    const cwd = projectWithCompiler("5.9.3", TS5_COMPILER);
    const res = await check(cwd);
    expect(res.status).toBe("pass");
    expect(argsOf(res.output)).toEqual([...COMMON, ...BASELINE, join(cwd, "gen", "x.spec.ts")]);
    expect(calls(cwd)).toBe(1);
  });

  it("retries without the 6+ flags when a compiler numbered 6, or with no usable version, rejects them", async () => {
    for (const version of ["6.0.0-beta", "nightly"]) {
      const cwd = projectWithCompiler(version, TS5_COMPILER);
      const res = await check(cwd);
      expect(res.status).toBe("pass");
      expect(argsOf(res.output)).not.toContain("--ignoreConfig");
      expect(calls(cwd)).toBe(2);
    }
  });

  it("retries with the 6+ flags when a compiler numbered 5 asks for them", async () => {
    const cwd = projectWithCompiler("5.9.3", MODERN_COMPILER);
    const res = await check(cwd);
    expect(res.status).toBe("pass");
    expect(argsOf(res.output)).toEqual(expect.arrayContaining(["--ignoreConfig", "--types", "*"]));
    expect(calls(cwd)).toBe(2);
  });

  it("starts a compiler with no usable version on the 6+ flags", async () => {
    const cwd = projectWithCompiler("nightly", MODERN_COMPILER);
    expect((await check(cwd)).status).toBe("pass");
    expect(calls(cwd)).toBe(1);
  });

  it("does not retry when a diagnostic only quotes a command-line error code, or a file name forges one", async () => {
    for (const compiler of [QUOTING_COMPILER, FORGING_COMPILER]) {
      for (const version of ["5.9.3", "7.0.2"]) {
        const cwd = projectWithCompiler(version, compiler);
        const res = await check(cwd);
        expect(res.status).toBe("fail");
        expect(res.output).toContain("error TS2322");
        expect(calls(cwd)).toBe(1);
      }
    }
  });

  it("loads Cypress's types for a Cypress spec, plus node when @types/node is installed", async () => {
    const withNode = projectWithCompiler("5.9.3", TS5_COMPILER, { nodeTypes: true });
    const nested = join(withNode, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(hasAmbientTypes(nested, "node")).toBe(true);
    const a = argsOf((await check(withNode, "cypress")).output);
    expect(a.slice(a.indexOf("--types"), a.indexOf("--types") + 2)).toEqual(["--types", "cypress,node"]);

    const withoutNode = projectWithCompiler("7.0.2", MODERN_COMPILER);
    const expected = hasAmbientTypes(withoutNode, "node") ? "cypress,node" : "cypress";
    const b = argsOf((await check(withoutNode, "cypress")).output);
    expect(b.slice(b.indexOf("--types"), b.indexOf("--types") + 2)).toEqual(["--types", expected]);
  });

  it("reports the compiler's own diagnostics on failure, without wrapper noise", async () => {
    const res = await check(projectWithCompiler("7.0.2", FAILING_COMPILER));
    expect(res.status).toBe("fail");
    expect(res.output).toBe("gen/x.spec.ts(5,11): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(res.truncated).toBeUndefined();
  });

  it("asks for plain diagnostics, so a compiler that would colour them still gets a FAIL", async () => {
    const res = await check(projectWithCompiler("7.0.2", COLOURED_COMPILER));
    expect(res.status).toBe("fail");
    expect(res.output).toBe(PLAIN_DIAGNOSTIC);
  });

  it("keeps the first part of a very long error list and still reports FAIL", async () => {
    const res = await check(projectWithCompiler("7.0.2", NOISY_COMPILER));
    expect(res.status).toBe("fail");
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBe(OUTPUT_LIMIT);
    expect(res.output.startsWith(DIAGNOSTIC_LINE)).toBe(true);
    const shown = formatDryRun(res, "/out/generated/x.spec.ts");
    expect(shown.structured).toMatchObject({ ok: false, status: "fail", truncated: true });
    expect(JSON.stringify(shown.structured).length).toBeLessThan(OUTPUT_LIMIT * 1.2);
    expect(shown.text.length).toBeLessThan(2_200);
  });

  it("runs the compiler with ELECTRON_RUN_AS_NODE, so an Electron host's binary (the VS Code extension) acts as Node", async () => {
    const res = await check(projectWithCompiler("7.0.2", ENV_COMPILER));
    expect(res.output).toBe("ELECTRON_RUN_AS_NODE=1");
  });

  it("gives no verdict when the compiler crashes instead of compiling (TypeScript 7 without its platform package)", async () => {
    const res = await check(projectWithCompiler("7.0.2", CRASHING_COMPILER));
    expect(res.status).toBe("unavailable");
    expect(res.typescriptVersion).toBe("7.0.2");
    expect(res.output).toMatch(/^TypeScript 7\.0\.2 could not be run, so the file was not type-checked:/);
    expect(res.output).toContain("Unable to resolve @typescript/typescript-linux-x64");
  });

  it.skipIf(!POSIX)("gives no verdict, and says why, when the compiler is killed", async () => {
    const res = await check(projectWithCompiler("7.0.2", SELF_KILLING_COMPILER));
    expect(res.status).toBe("unavailable");
    expect(res.output).toContain("The compiler was stopped by SIGKILL.");
  });

  it("gives no verdict when the compiler cannot be started at all", async () => {
    const cwd = projectWithCompiler("7.0.2", MODERN_COMPILER);
    const realExecPath = process.execPath;
    process.execPath = join(cwd, "no-such-node");
    try {
      const res = await check(cwd);
      expect(res.status).toBe("unavailable");
      expect(res.output).toMatch(/could not be run[\s\S]*ENOENT/);
    } finally {
      process.execPath = realExecPath;
    }
  });

  it("stops a compiler that ignores SIGTERM at the timeout, and gives no verdict", async () => {
    const cwd = projectWithCompiler("7.0.2", STUBBORN_COMPILER);
    const started = Date.now();
    const res = await check(cwd, "playwright", 2_000);
    expect(res.status).toBe("unavailable");
    expect(res.output).toBe("TypeScript 7.0.2 did not finish within 2000 ms, so there is no verdict on the file.");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await isGone(cwd, "compiler.pid")).toBe(true);
  });

  it("does not cut a check short when the configured timeout is larger than a timer can hold", async () => {
    // setTimeout runs a delay above 2^31-1 ms after 1 ms.
    const res = await check(projectWithCompiler("7.0.2", MODERN_COMPILER), "playwright", 3_000_000_000);
    expect(res.status).toBe("pass");
  });

  it.skipIf(!POSIX)("stops the compiler's own child processes at the timeout", async () => {
    const cwd = projectWithCompiler("7.0.2", PARENT_OF_COMPILER);
    writeFileSync(join(cwd, "node_modules", "typescript", "bin", "idle.js"), IDLE);
    const res = await check(cwd, "playwright", 4_000);
    expect(res.status).toBe("unavailable");
    expect(await isGone(cwd, "grandchild.pid")).toBe(true);
  });

  it.skipIf(!POSIX || !NOTHING_ABOVE_TMP)("runs a global compiler when the project has none", async () => {
    const { prefix, binDir } = globalInstall("5.9.3", TS5_COMPILER);
    for (const lookup of [{ path: binDir, npmPrefixes: [] }, { path: "", npmPrefixes: [prefix] }]) {
      const cwd = tempDir();
      const res = await typeCheckFile({ file: join(cwd, "x.spec.ts"), cwd, framework: "playwright", timeoutMs: 20_000, lookup });
      expect(res).toMatchObject({ status: "pass", typescriptVersion: "5.9.3" });
    }
  });

  it.skipIf(!NOTHING_ABOVE_TMP)("gives no verdict, and runs nothing, when no TypeScript is installed (the hosted image)", async () => {
    const res = await check(tempDir());
    expect(res.status).toBe("unavailable");
    expect(res.typescriptVersion).toBeUndefined();
    expect(res.output).toContain("TypeScript was not found");
    expect(res.output).toContain("never downloads one");
  });
});

describe("with the repo's real compiler, run from the repo root (which has a tsconfig.json)", () => {
  const real = (source: string) => {
    const dir = tempDir();
    const file = join(dir, "sample.spec.ts");
    writeFileSync(file, source);
    return typeCheckFile({ file, cwd: repoRoot, framework: "vitest", timeoutMs: 120_000, lookup: NONE });
  };

  it("passes a valid file", async () => {
    const res = await real("export const answer: number = 42;\n");
    expect(res.output).not.toContain("TS5112");
    expect(res.status).toBe("pass");
    expect(res.typescriptVersion).toMatch(/^\d+\.\d+/);
  });

  it("fails a broken file with the real diagnostic", async () => {
    const res = await real('export const answer: number = "forty-two";\n');
    expect(res.status).toBe("fail");
    expect(res.output).toContain("TS2322");
    expect(res.output).not.toContain("TS5112");
  });

  it("still fails a broken file when FORCE_COLOR is set, which makes TypeScript 6 and 7 colour their output", async () => {
    const before = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const res = await real('export const answer: number = "forty-two";\n');
      expect(res.status).toBe("fail");
      expect(res.output).toContain("error TS2322:");
      expect(res.output).not.toContain("\u001b[");
    } finally {
      if (before === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = before;
    }
  });

  it("accepts modern code that TypeScript 5's own defaults (ES5, CommonJS) rejected", async () => {
    const res = await real(
      [
        'import path from "node:path";',
        "const last = [1, 2, 3].at(-1);",
        'const name = path.basename("a/b").replaceAll("b", "c");',
        "for (const [key, value] of new Map([[1, 2]])) console.log(key, value);",
        "export const result = await Promise.resolve([last, name]);",
        "",
      ].join("\n"),
    );
    expect(res.output).toBe("");
    expect(res.status).toBe("pass");
  });

  it("checks strictly: a value that may be null is an error", async () => {
    const res = await real("declare const text: string | null;\nexport const length: number = text.length;\n");
    expect(res.status).toBe("fail");
    expect(res.output).toContain("TS18047");
  });
});

describe("tr_dry_run_test tool", () => {
  const tool = ALL_TOOLS.find((t) => t.name === "tr_dry_run_test")!;
  const contextFor = (outputDir: string) => ({ config: { outputDir, timeouts: { analysis: 120_000 } } }) as unknown as ToolContext;
  /** An output directory holding one valid generated file. */
  function outputDirWith(name: string): string {
    const outputDir = tempDir();
    mkdirSync(join(outputDir, "generated"), { recursive: true });
    writeFileSync(join(outputDir, "generated", name), "export const answer: number = 42;\n");
    return outputDir;
  }

  it("returns PASS with the compiler version for a valid generated file", async () => {
    const outputDir = outputDirWith("ok.spec.ts");
    const res = await tool.handler({ file_path: "generated/ok.spec.ts" }, contextFor(outputDir));
    expect(res.text.split("\n")[0]).toBe("## Dry-run: PASS");
    expect(res.structured).toMatchObject({ ok: true, status: "pass", file: join(outputDir, "generated", "ok.spec.ts") });
    expect((res.structured as { typescript_version?: string }).typescript_version).toMatch(/^\d+\./);
  });

  it("checks a *.cy.ts file as Cypress even when the caller sends another framework", async () => {
    // Cypress is not installed in this repo, so asking for its types is an
    // error from the real compiler: that is what shows they were asked for.
    const outputDir = outputDirWith("a.cy.ts");
    const res = await tool.handler({ file_path: "generated/a.cy.ts", framework: "playwright" }, contextFor(outputDir));
    expect(res.structured).toMatchObject({ ok: false, status: "fail" });
    expect(res.text).toContain("TS2688");
    expect(res.text).toContain("cypress");
  });

  it("never runs a compiler planted in the output directory, whose contents a caller influences", async () => {
    const outputDir = outputDirWith("ok.spec.ts");
    const marker = join(outputDir, "planted-compiler-ran");
    const planted = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`;
    for (const dir of [outputDir, join(outputDir, "generated")]) {
      writeCompiler(join(dir, "node_modules", "typescript"), "9.9.9-planted", planted);
    }
    const res = await tool.handler({ file_path: "generated/ok.spec.ts" }, contextFor(outputDir));
    expect(existsSync(marker)).toBe(false);
    expect(res.structured).toMatchObject({ ok: true, status: "pass" });
    expect((res.structured as { typescript_version?: string }).typescript_version).not.toBe("9.9.9-planted");
  });

  it("passes the file tr_generate_test writes, and fails it once a type error is put in", async () => {
    // Imports resolve from the file's own directory, so the output directory
    // has to sit where `vitest` can be found: inside this repo.
    const outputDir = repoTempDir();
    const srv = await startInProcessServer({ capabilities: ["creation"], outputDir });
    try {
      const generate = ALL_TOOLS.find((t) => t.name === "tr_generate_test")!;
      const plan = { goal: "Cart total", framework: "vitest" as const, steps: [{ step: 1, action: "Add an item", expectation: "Total updates" }] };
      const generated = await generate.handler({ project_id: "PROJ-1", plan }, srv.__ctx);
      const { file_path } = generated.structured as { file_path: string };

      const passed = await tool.handler({ file_path }, srv.__ctx);
      expect(passed.structured).toMatchObject({ ok: true, status: "pass" });

      writeFileSync(file_path, readFileSync(file_path, "utf8") + '\nexport const broken: number = "no";\n');
      const failed = await tool.handler({ file_path }, srv.__ctx);
      expect(failed.structured).toMatchObject({ ok: false, status: "fail" });
      expect(failed.text).toContain("TS2322");
    } finally {
      await srv.stop();
    }
  });

  it("keeps the documented result shape for each outcome", () => {
    const file = "/out/generated/x.spec.ts";
    expect(formatDryRun({ status: "pass", output: "", typescriptVersion: "7.0.2" }, file).structured).toEqual({
      ok: true,
      status: "pass",
      results: [{ step: "tsc --noEmit", ok: true, output: "" }],
      file,
      typescript_version: "7.0.2",
    });
    const failed = formatDryRun({ status: "fail", output: "x.ts(1,1): error TS2322: nope", typescriptVersion: "5.9.3" }, file);
    expect(failed.text).toContain("## Dry-run: FAIL");
    expect(failed.structured).toMatchObject({ ok: false, status: "fail" });
  });

  it("says NO VERDICT, not FAIL, when the check could not run", () => {
    const out = formatDryRun({ status: "unavailable", output: "TypeScript was not found" }, "/out/generated/x.spec.ts");
    expect(out.text.split("\n")[0]).toBe("## Dry-run: NO VERDICT");
    expect(out.text).not.toContain("FAIL");
    expect(out.structured).toMatchObject({ ok: false, status: "unavailable" });
    expect(out.structured).not.toHaveProperty("typescript_version");
  });

  it("never shells out to npx (it fetches and runs the registry package `tsc` when TypeScript is missing)", () => {
    for (const rel of ["typecheck.ts", "index.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`../../packages/mcp/src/tools/creation/${rel}`, import.meta.url)), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/["'`]npx["'`]/);
    }
  });
});
