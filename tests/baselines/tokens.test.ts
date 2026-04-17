import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess } from "node:child_process";
import { startInProcessServer, startMockServer, stopMockServer } from "../fixtures/server.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import { countObjectTokens } from "../../packages/mcp/src/telemetry/tokens.js";
import type { TestRelicServer } from "../../packages/mcp/src/index.js";

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
});
