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
