import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { startInProcessServer } from "../fixtures/server.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import { buildAllowList, isLoopbackHost } from "../../packages/mcp/src/transport/http.js";

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
