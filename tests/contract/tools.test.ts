import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess } from "node:child_process";
import { startInProcessServer, startMockServer, stopMockServer } from "../fixtures/server.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";

let mock: ChildProcess | undefined;

beforeAll(async () => {
  mock = await startMockServer();
}, 30_000);

afterAll(async () => {
  await stopMockServer(mock);
});

describe("contract: tool registry", () => {
  it("registers tools only for enabled capabilities", async () => {
    const { registeredTools, stop } = await startInProcessServer({ capabilities: ["coverage"] });
    try {
      const caps = new Set(registeredTools.map((t) => t.capability));
      expect(caps.has("core")).toBe(true);
      expect(caps.has("coverage")).toBe(true);
      expect(caps.has("impact")).toBe(false);
      expect(caps.has("creation")).toBe(false);
      // New surfaces are off unless explicitly opted in.
      expect(caps.has("ai")).toBe(false);
      expect(caps.has("marketplace")).toBe(false);
      expect(caps.has("apps")).toBe(false);
      expect(caps.has("artifacts")).toBe(false);
    } finally {
      await stop();
    }
  });

  it("opt-in for ai/marketplace/apps/artifacts capabilities", async () => {
    const { registeredTools, stop } = await startInProcessServer({
      capabilities: ["ai", "marketplace", "apps", "artifacts"],
    });
    try {
      const names = new Set(registeredTools.map((t) => t.name));
      expect(names.has("tr_ai_execute")).toBe(true);
      expect(names.has("tr_ask_ai")).toBe(true);
      expect(names.has("tr_marketplace_list_apps")).toBe(true);
      expect(names.has("tr_marketplace_invoke")).toBe(true);
      expect(names.has("tr_apps_list")).toBe(true);
      expect(names.has("tr_apps_execute")).toBe(true);
      expect(names.has("tr_artifacts_list")).toBe(true);
    } finally {
      await stop();
    }
  });

  it("every tool has a unique name and a tr_ or testrelic_ prefix", () => {
    const seen = new Set<string>();
    for (const t of ALL_TOOLS) {
      expect(seen.has(t.name), `duplicate tool name: ${t.name}`).toBe(false);
      seen.add(t.name);
      expect(t.name.startsWith("tr_") || t.name.startsWith("testrelic_")).toBe(true);
      for (const a of t.aliases ?? []) {
        expect(seen.has(a.name), `duplicate alias name: ${a.name}`).toBe(false);
        seen.add(a.name);
      }
    }
  });
});

describe("contract: core capability", () => {
  it("tr_recent_runs returns the list shape the agent expects", async () => {
    const srv = await startInProcessServer();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_recent_runs")!;
      const result = await tool.handler({ limit: 3 }, srv.__ctx);
      expect(result.text).toMatch(/(Runs|runs)/);
      const s = result.structured as { runs?: unknown[] };
      expect(Array.isArray(s.runs)).toBe(true);
    } finally {
      await srv.stop();
    }
  });
});

describe("contract: coverage capability", () => {
  it("tr_coverage_report returns user_coverage and test_coverage", async () => {
    const srv = await startInProcessServer();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_coverage_report")!;
      const result = await tool.handler({ project_id: "PROJ-1", read_mode: "full" }, srv.__ctx);
      const s = result.structured as { user_coverage: number; test_coverage: number; meets_95_user: boolean };
      expect(typeof s.user_coverage).toBe("number");
      expect(typeof s.test_coverage).toBe("number");
      expect(typeof s.meets_95_user).toBe("boolean");
    } finally {
      await srv.stop();
    }
  });

  it("tr_coverage_gaps returns gaps ordered by user_count", async () => {
    const srv = await startInProcessServer();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_coverage_gaps")!;
      const result = await tool.handler({ project_id: "PROJ-1", limit: 5 }, srv.__ctx);
      const s = result.structured as { gaps: Array<{ user_count: number }> };
      expect(s.gaps.length).toBeGreaterThan(0);
      for (let i = 1; i < s.gaps.length; i++) {
        expect(s.gaps[i - 1]!.user_count >= s.gaps[i]!.user_count).toBe(true);
      }
    } finally {
      await srv.stop();
    }
  });
});

describe("contract: impact capability", () => {
  it("tr_analyze_diff returns a risk score for a real file path", async () => {
    const srv = await startInProcessServer();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_analyze_diff")!;
      const result = await tool.handler(
        { project_id: "PROJ-1", files: ["src/checkout/api.ts"] },
        srv.__ctx,
      );
      const s = result.structured as { risk_score: number; risk_level: string; touched_test_count?: number };
      expect(typeof s.risk_score).toBe("number");
      expect(["low", "medium", "high", "critical"]).toContain(s.risk_level);
    } finally {
      await srv.stop();
    }
  });

  it("tr_select_tests classifies MUST/SHOULD/OPTIONAL without overlap", async () => {
    const srv = await startInProcessServer();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_select_tests")!;
      const result = await tool.handler(
        { project_id: "PROJ-1", files: ["src/checkout/api.ts"] },
        srv.__ctx,
      );
      const s = result.structured as { must: string[]; should: string[]; optional: string[] };
      const seen = new Set<string>();
      for (const arr of [s.must, s.should, s.optional]) {
        for (const id of arr) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
      }
    } finally {
      await srv.stop();
    }
  });
});

describe("contract: devtools capability", () => {
  it("tr_project_trends renders pass_rate as a 0–100 percentage (no 100x double-scale)", async () => {
    const srv = await startInProcessServer();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_project_trends")!;
      const result = await tool.handler({ project_id: "PROJ-1", days: 7 }, srv.__ctx);
      // Mock + real platform both return passRate on a 0–100 scale; the table must
      // show e.g. "95.0%", never a double-scaled "9500.0%". Guards the unit-drift
      // bug where the tool multiplied an already-0–100 value by 100.
      expect(result.text).toMatch(/\b9\d\.\d%/);      // a plausible 90–99% value
      expect(result.text).not.toMatch(/\d{3,}\.\d%/); // no 3+ digit percentage (9500.0%)
      const s = result.structured as {
        trends: { data: Array<{ pass_rate: number; total_runs: number }> };
      };
      expect(s.trends.data.length).toBeGreaterThan(0);
      for (const p of s.trends.data) {
        expect(p.pass_rate).toBeGreaterThan(1); // 0–100 scale, not a 0–1 fraction
        expect(p.pass_rate).toBeLessThanOrEqual(100);
        expect(typeof p.total_runs).toBe("number"); // backend bucket now carries totalRuns
      }
    } finally {
      await srv.stop();
    }
  });
});
