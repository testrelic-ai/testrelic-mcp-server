import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess } from "node:child_process";
import { startInProcessServer, startMockServer, stopMockServer } from "../fixtures/server.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import { countObjectTokens } from "../../packages/mcp/src/telemetry/tokens.js";
import type { TestRelicServer } from "../../packages/mcp/src/index.js";
import type { Capability } from "../../packages/mcp/src/config.js";

const ALL_CAPS: Capability[] = [
  "core",
  "coverage",
  "creation",
  "healing",
  "impact",
  "triage",
  "signals",
  "devtools",
  "ai",
  "marketplace",
  "apps",
  "artifacts",
  "memory",
];

/**
 * Token baselines — the core contract of v2 is "60% fewer tokens than a
 * plain LLM prompt". These tests pin ceilings for the common workflows so
 * regressions are caught in CI.
 */

let mock: ChildProcess | undefined;

beforeAll(async () => {
  mock = await startMockServer();
}, 30_000);

afterAll(async () => {
  await stopMockServer(mock);
});

async function runTool(name: string, input: Record<string, unknown>, srv: TestRelicServer) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.handler(input, srv.__ctx);
}

describe("token baselines", () => {
  it("tr_coverage_report stays under 2500 tokens", async () => {
    const srv = await startInProcessServer();
    try {
      const result = await runTool("tr_coverage_report", { project_id: "PROJ-1", read_mode: "full" }, srv);
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(2_500);
    } finally {
      await srv.stop();
    }
  });

  it("tr_coverage_gaps stays under 1800 tokens for 10 gaps", async () => {
    const srv = await startInProcessServer();
    try {
      const result = await runTool("tr_coverage_gaps", { project_id: "PROJ-1", limit: 10 }, srv);
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(1_800);
    } finally {
      await srv.stop();
    }
  });

  it("tr_analyze_diff stays under 1600 tokens", async () => {
    const srv = await startInProcessServer();
    try {
      const result = await runTool(
        "tr_analyze_diff",
        { project_id: "PROJ-1", files: ["src/checkout/api.ts", "src/checkout/ui.ts"] },
        srv,
      );
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(1_600);
    } finally {
      await srv.stop();
    }
  });

  it("coverage report 3-state diff drops second read below 400 tokens", async () => {
    const srv = await startInProcessServer();
    try {
      await runTool("tr_coverage_report", { project_id: "PROJ-1", read_mode: "auto" }, srv);
      const second = await runTool("tr_coverage_report", { project_id: "PROJ-1", read_mode: "auto" }, srv);
      const tokens = countObjectTokens(second.text);
      expect(tokens).toBeLessThan(400);
    } finally {
      await srv.stop();
    }
  });

  // ── New surfaces: ai / marketplace / apps / artifacts ───────────────────
  // These tools live behind capabilities that aren't on by default in the
  // fixture, so each test boots its own server with the full cap set.

  it("tr_ai_list_tools stays under 1500 tokens for the mock catalog (3 tools)", async () => {
    const srv = await startInProcessServer({ capabilities: ALL_CAPS });
    try {
      const result = await runTool("tr_ai_list_tools", {}, srv);
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(1_500);
    } finally {
      await srv.stop();
    }
  });

  // The mock catalog mirrors prod's serialisation, so the list rows carry the
  // `configFields` the endpoint really returns. The handler projects them away
  // (they belong to tr_marketplace_get_app), which is what keeps this under
  // the ceiling — against raw prod rows the same payload measures ~1400.
  it("tr_marketplace_list_apps stays under 1200 tokens for the mock catalog (4 apps)", async () => {
    const srv = await startInProcessServer({ capabilities: ALL_CAPS });
    try {
      const result = await runTool("tr_marketplace_list_apps", {}, srv);
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(1_200);
    } finally {
      await srv.stop();
    }
  });

  it("tr_apps_list stays under 800 tokens (3 mock apps)", async () => {
    const srv = await startInProcessServer({ capabilities: ALL_CAPS });
    try {
      const result = await runTool("tr_apps_list", {}, srv);
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(800);
    } finally {
      await srv.stop();
    }
  });

  it("tr_artifacts_list stays under 1200 tokens (2 mock artifacts)", async () => {
    const srv = await startInProcessServer({ capabilities: ALL_CAPS });
    try {
      const result = await runTool("tr_artifacts_list", {}, srv);
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(1_200);
    } finally {
      await srv.stop();
    }
  });

  // Was `tr_generate_dashboard` until 3.3.0. That tool was one of five
  // artifact-generator wrappers that all resolved to the same
  // cloud.executeAiTool call as tr_ai_execute, so they were removed. Same
  // scenario, same ceiling — exercised through the surviving path.
  it("dashboard artifact via tr_ai_execute stays under 1800 tokens", async () => {
    const srv = await startInProcessServer({ capabilities: ALL_CAPS });
    try {
      const result = await runTool(
        "tr_ai_execute",
        { tool_name: "generate_dashboard", input: { title: "Mock dashboard" } },
        srv,
      );
      const tokens = countObjectTokens(result.text) + countObjectTokens(result.structured ?? {});
      expect(tokens).toBeLessThan(1_800);
    } finally {
      await srv.stop();
    }
  });

  // TODO: 3-state diff for `tr_marketplace_list_apps` is skipped intentionally.
  // The diff reader is opt-in per-tool via the `read_mode = auto | full` input
  // parameter, and the marketplace tool doesn't declare/handle that parameter
  // (no read_mode in its inputSchema, no auto-mode branch in its handler).
  // Re-enable this once `tr_marketplace_list_apps` adopts the read_mode pattern.
  it.skip("tr_marketplace_list_apps 3-state diff drops second read below 300 tokens", async () => {
    const srv = await startInProcessServer({ capabilities: ALL_CAPS });
    try {
      await runTool("tr_marketplace_list_apps", { read_mode: "auto" }, srv);
      const second = await runTool("tr_marketplace_list_apps", { read_mode: "auto" }, srv);
      const tokens = countObjectTokens(second.text);
      expect(tokens).toBeLessThan(300);
    } finally {
      await srv.stop();
    }
  });
});
