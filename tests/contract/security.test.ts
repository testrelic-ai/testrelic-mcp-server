import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { startInProcessServer } from "../fixtures/server.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import { buildAllowList, isLoopbackHost } from "../../packages/mcp/src/transport/http.js";
import { resolveWithinDir } from "../../packages/mcp/src/util/paths.js";

const PLAN = {
  goal: "Login flow",
  framework: "playwright" as const,
  steps: [{ step: 1, action: "Navigate to /login", expectation: "Login form is visible" }],
};

/**
 * TEAI-271 — the creation tools shell out to `tsc` and write files. Both the
 * write path (tr_generate_test) and the type-check path (tr_dry_run_test) must
 * be confined to the configured outputDir, so path traversal / arbitrary
 * absolute paths cannot reach the rest of the filesystem.
 */
describe("security: creation path containment (TEAI-271)", () => {
  it("tr_generate_test strips traversal from file_name and writes under outputDir/generated", async () => {
    const srv = await startInProcessServer({ capabilities: ["creation"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_generate_test")!;
      const res = await tool.handler(
        { project_id: "PROJ-1", plan: PLAN, file_name: "../../../../evil.spec.ts" },
        srv.__ctx,
      );
      const s = res.structured as { file_path: string };
      const outGen = resolve(srv.__ctx.config.outputDir, "generated");
      expect(s.file_path.startsWith(outGen + sep)).toBe(true);
      expect(s.file_path).toContain("evil.spec.ts");
      // The traversal segments must NOT survive.
      expect(s.file_path).not.toContain("..");
      expect(existsSync(s.file_path)).toBe(true);
    } finally {
      await srv.stop();
    }
  });

  it("tr_dry_run_test rejects a relative traversal file_path", async () => {
    const srv = await startInProcessServer({ capabilities: ["creation"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_dry_run_test")!;
      await expect(
        tool.handler({ file_path: "../../../../etc/passwd" }, srv.__ctx),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await srv.stop();
    }
  });

  it("tr_dry_run_test rejects an absolute path outside outputDir", async () => {
    const srv = await startInProcessServer({ capabilities: ["creation"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_dry_run_test")!;
      const abs = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
      await expect(tool.handler({ file_path: abs }, srv.__ctx)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    } finally {
      await srv.stop();
    }
  });
});

/**
 * Shared path-containment gate. Every tool that turns caller text into a
 * filesystem path routes through this; a regression here is an arbitrary
 * read/write primitive on the hosted transport.
 */
describe("security: resolveWithinDir containment", () => {
  const base = resolve("/tmp/tr-base");
  it("allows a plain filename and a nested subpath", () => {
    expect(resolveWithinDir(base, "artifact.json")).toBe(resolve(base, "artifact.json"));
    expect(resolveWithinDir(base, "sub/dir/a.json")).toBe(resolve(base, "sub/dir/a.json"));
  });
  it("rejects ../ traversal, absolute paths, and the base itself", () => {
    for (const bad of ["../../../../etc/passwd", "../escape.json", "/etc/cron.d/x", "."]) {
      expect(() => resolveWithinDir(base, bad)).toThrowError(/escapes the allowed directory/);
    }
  });
});

/**
 * tr_artifacts_save_to_file must contain the caller-supplied `filename`. A bare
 * join() let `../../etc/x` escape outputDir — arbitrary file write as the
 * server-process user, reachable remotely on the hosted HTTP transport.
 */
describe("security: tr_artifacts_save_to_file path containment", () => {
  it("rejects a traversal filename before any fetch or write", async () => {
    // No mock server needed: containment is validated up front, so a hostile
    // filename throws before getArtifact is ever called (the positive
    // happy-path write is covered by the dogfood + live-stage runs).
    const srv = await startInProcessServer({ capabilities: ["artifacts"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_artifacts_save_to_file")!;
      for (const bad of ["../../../../evil.json", "/etc/cron.d/x", "..\\..\\win.txt"]) {
        await expect(
          tool.handler({ id: "art-mock-1", filename: bad }, srv.__ctx),
        ).rejects.toThrow(/escapes the allowed directory|PATH_TRAVERSAL/);
      }
    } finally {
      await srv.stop();
    }
  });
});

/**
 * TEAI-280 — the Streamable HTTP transport enables DNS-rebinding protection
 * with an allow-list of loopback names + the configured host on our port.
 */
describe("security: http DNS-rebinding allow-list (TEAI-280)", () => {
  it("allow-list covers loopback names and the configured host on the bound port", () => {
    const { allowedHosts, allowedOrigins } = buildAllowList("127.0.0.1", 3000);
    expect(allowedHosts).toContain("127.0.0.1:3000");
    expect(allowedHosts).toContain("localhost:3000");
    expect(allowedHosts).toContain("[::1]:3000");
    expect(allowedOrigins).toContain("http://127.0.0.1:3000");
    expect(allowedOrigins).toContain("http://localhost:3000");
  });

  it("includes an explicitly configured non-default host", () => {
    const { allowedHosts } = buildAllowList("mcp.internal", 8080);
    expect(allowedHosts).toContain("mcp.internal:8080");
    // Still trusts loopback so local health checks keep working.
    expect(allowedHosts).toContain("127.0.0.1:8080");
  });

  it("brackets a bare IPv6 configured host", () => {
    const { allowedHosts } = buildAllowList("::1", 3000);
    expect(allowedHosts).toContain("[::1]:3000");
  });

  /**
   * The hosted-deployment regression: CloudFront → nginx forwards the PUBLIC
   * hostname in the Host header (`proxy_set_header Host $host`), but the
   * allow-list only knew the bind address — so mcp-stage.testrelic.ai rejected
   * EVERY real client with 403 "Invalid Host header" from the moment this
   * hardening shipped. Public hosts must be allowed both bare (a :443
   * proxy forwards no port) and on our port.
   */
  it("publicHosts extends the allow-list for proxied deployments (bare + port)", () => {
    const { allowedHosts, allowedOrigins } = buildAllowList("0.0.0.0", 3000, [
      "mcp-stage.testrelic.ai",
      " new.mcp-stage.testrelic.ai ", // whitespace tolerated
    ]);
    expect(allowedHosts).toContain("mcp-stage.testrelic.ai"); // as nginx forwards it
    expect(allowedHosts).toContain("mcp-stage.testrelic.ai:3000");
    expect(allowedHosts).toContain("new.mcp-stage.testrelic.ai");
    // NOTE: this previously asserted `allowedOrigins` contained
    // "https://mcp-stage.testrelic.ai". That assertion encoded the Origin bug
    // below — a hosted deployment now enforces no Origin allow-list at all.
    // Host coverage, which is what this case is about, is unchanged.
    expect(allowedOrigins).toEqual([]);
    // The rebinding protection still rejects arbitrary names.
    expect(allowedHosts).not.toContain("evil.example.com");
  });

  /**
   * The Origin half of the same bug, and the one that broke customers on
   * 2026-09-01. `allowedOrigins` was derived from the Host allow-list, so it
   * could only ever contain our own hostnames — while real MCP clients send
   * `https://claude.ai`, `vscode-webview://<random>`, `app://...` or a literal
   * `null`. Every one of them got 403 "Invalid Origin header", while a bare
   * curl (no Origin header) succeeded, so every probe we ran looked healthy.
   *
   * The SDK skips Origin validation when the list is empty and still enforces
   * allowedHosts, so rebinding protection is retained.
   */
  it("hosted deployments do not enforce an Origin allow-list", () => {
    const { allowedHosts, allowedOrigins } = buildAllowList("0.0.0.0", 3000, [
      "mcp.testrelic.ai",
    ]);
    expect(allowedOrigins).toEqual([]);
    // Host protection is untouched — this is what actually stops rebinding.
    expect(allowedHosts).toContain("mcp.testrelic.ai");
    expect(allowedHosts).not.toContain("evil.example.com");
  });

  it("a non-loopback bind is treated as hosted even without publicHosts", () => {
    expect(buildAllowList("0.0.0.0", 3000).allowedOrigins).toEqual([]);
    expect(buildAllowList("10.0.1.7", 3000).allowedOrigins).toEqual([]);
  });

  it("loopback servers KEEP the Origin allow-list (a web page can reach 127.0.0.1)", () => {
    for (const h of ["127.0.0.1", "localhost", "::1"]) {
      const { allowedOrigins } = buildAllowList(h, 3000);
      expect(allowedOrigins.length).toBeGreaterThan(0);
      expect(allowedOrigins).toContain("http://127.0.0.1:3000");
      // A hostile page's own origin is still not on the list.
      expect(allowedOrigins).not.toContain("https://evil.example.com");
    }
  });

  it("publicHosts defaults keep the strict local-only allow-list", () => {
    const { allowedHosts } = buildAllowList("127.0.0.1", 3000);
    expect(allowedHosts.every((h) => !h.includes("testrelic.ai"))).toBe(true);
  });

  it("classifies loopback vs. non-loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("mcp.internal")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});
