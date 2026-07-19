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
      expect(caps.has("memory")).toBe(false);
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

  // ── Anti-regrowth guards ────────────────────────────────────────────────
  //
  // Name-uniqueness alone did not catch the duplication that accumulated
  // through 3.2.x: `tr_list_runs` was a byte-for-byte behavioural duplicate of
  // `tr_recent_runs` and passed CI for months because the two strings differ.
  // These three guards each would have failed on it.

  /**
   * Capability gating only pays off while the total surface stays small. The
   * registry's own design comment claimed "~35 tools" while the real number had
   * reached 86 — nobody noticed because nothing measured it.
   *
   * Raising this ceiling is a deliberate act: every registered name is sent in
   * the tool-schema prelude of every request, to every client, forever. Prefer
   * one tool with a discriminator parameter over two near-identical tools.
   */
  it("the registered surface stays under the agreed ceiling", () => {
    const canonical = ALL_TOOLS.length;
    const withAliases = canonical + ALL_TOOLS.reduce((n, t) => n + (t.aliases?.length ?? 0), 0);
    expect(canonical, `canonical tools: ${canonical}`).toBeLessThanOrEqual(70);
    expect(withAliases, `incl. legacy aliases: ${withAliases}`).toBeLessThanOrEqual(85);
  });

  /**
   * A tool that describes itself as a duplicate is a duplicate. `tr_list_runs`
   * was titled "legacy alias of tr_recent_runs" and described as "behaviour
   * identical" — the information needed to delete it was sitting in its own
   * registration the whole time. If a tool really is a compatibility shim, it
   * belongs in `aliases` (which is opt-in), not as a canonical tool.
   */
  it("no canonical tool advertises itself as an alias or duplicate", () => {
    const tell = /\b(legacy alias|alias of|behaviour identical|behavior identical|identical to)\b/i;
    for (const t of ALL_TOOLS) {
      const text = `${t.title} ${t.description}`;
      expect(
        tell.test(text),
        `${t.name} declares itself a duplicate — move it to \`aliases\` or delete it: "${text.slice(0, 160)}"`,
      ).toBe(false);
    }
  });

  /**
   * `deprecated: true` on a canonical tool is a contradiction: it is still
   * registered, so it still costs prelude tokens for every client, while
   * telling the model not to use it. Deprecate by moving the name into
   * `aliases` (gated behind --legacy-aliases) or by removing it.
   */
  it("no canonical tool is marked deprecated while still registered", () => {
    const deprecated = ALL_TOOLS.filter((t) => t.deprecated).map((t) => t.name);
    expect(deprecated, `deprecated but still registered: ${deprecated.join(", ")}`).toEqual([]);
  });

  /**
   * Truncation recovery must be reachable from every capability set. Every tool
   * result is capped at tokenBudgetPerTool and returns a cacheKey; while
   * `tr_fetch_cached` sat in `coverage`, a client on `--caps core,triage` got
   * truncated payloads with no registered tool able to redeem the key.
   */
  it("tr_fetch_cached is reachable without the coverage capability", async () => {
    const { registeredTools, stop } = await startInProcessServer({ capabilities: ["triage"] });
    try {
      const names = new Set(registeredTools.map((t) => t.name));
      expect(names.has("tr_fetch_cached")).toBe(true);
    } finally {
      await stop();
    }
  });

  /**
   * Client/server version skew must degrade, never fail closed.
   *
   * `TESTRELIC_MCP_CAPS` is set by independently released clients — the shipped
   * testrelic-cli pins `"core,...,config,ai,marketplace,apps,artifacts,sessions"`
   * in `mcp_config.rs` and still sends the retired `config` and `sessions`. When
   * the capability list was a strict Zod enum, one unrecognised name threw during
   * config parse and the process exited **before registering any tool**, so the
   * calling agent silently got zero TestRelic tools. That outage already happened
   * once (the CLI sent a then-nonexistent `memory`).
   */
  it("retired and unknown capabilities are ignored, not fatal", async () => {
    // The exact string the shipped CLI sends in Cloud mode.
    const shippedCliCaps = [
      "core", "coverage", "creation", "healing", "impact", "triage", "signals",
      "devtools", "config", "ai", "marketplace", "apps", "artifacts", "sessions",
    ];
    const { registeredTools, stop } = await startInProcessServer({
      capabilities: shippedCliCaps as never,
    });
    try {
      // The real capabilities still registered — a partial surface, not none.
      const names = new Set(registeredTools.map((t) => t.name));
      expect(registeredTools.length).toBeGreaterThan(40);
      expect(names.has("tr_recent_runs")).toBe(true);
      expect(names.has("tr_ai_execute")).toBe(true);
      expect(names.has("tr_marketplace_invoke")).toBe(true);
    } finally {
      await stop();
    }
  });

  it("a wholly unknown capability does not crash the server", async () => {
    const { registeredTools, stop } = await startInProcessServer({
      capabilities: ["core", "definitely_not_a_capability"] as never,
    });
    try {
      expect(registeredTools.length).toBeGreaterThan(0);
      expect(registeredTools.every((t) => t.capability === "core")).toBe(true);
    } finally {
      await stop();
    }
  });

  /**
   * Legacy v1 aliases are opt-in since 3.3.0. Default-on cost 14 registered
   * names — 16% of the surface — for zero new capability.
   */
  it("legacy testrelic_* aliases are off by default and restorable on demand", async () => {
    const off = await startInProcessServer({ capabilities: ["triage", "signals", "devtools"] });
    try {
      expect(off.registeredTools.some((t) => t.name.startsWith("testrelic_"))).toBe(false);
    } finally {
      await off.stop();
    }

    const on = await startInProcessServer({
      capabilities: ["triage", "signals", "devtools"],
      legacyAliases: true,
    });
    try {
      const legacy = on.registeredTools.filter((t) => t.name.startsWith("testrelic_"));
      expect(legacy.length).toBeGreaterThan(0);
    } finally {
      await on.stop();
    }
  });
});

describe("contract: triage capability", () => {
  /**
   * The platform's /mcp/flakiness returns `score` as a 0–100 percentage; the
   * internal FlakyTest contract is a 0–1 fraction. Before normalization a real
   * score of 82 reached `"░".repeat(10 - 820)` and threw
   * `Invalid count value: -810`, killing the whole tool call. Found by
   * scripts/dogfood-all.ts — the empty-data path passed, only real data threw.
   */
  it("tr_flaky_audit renders real scores without throwing and reports fractions", async () => {
    const { registeredTools, stop, __ctx } = await startInProcessServer({ capabilities: ["triage"] });
    try {
      expect(registeredTools.some((t) => t.name === "tr_flaky_audit")).toBe(true);
      const tool = ALL_TOOLS.find((t) => t.name === "tr_flaky_audit")!;
      const r = (await tool.handler({}, __ctx)) as {
        text: string;
        structured?: { tests?: Array<{ flakiness_score: number }> };
        isError?: boolean;
      };
      expect(r.isError).not.toBe(true);
      const tests = r.structured?.tests ?? [];
      expect(tests.length).toBeGreaterThan(0);
      for (const t of tests) {
        expect(t.flakiness_score).toBeGreaterThanOrEqual(0);
        expect(t.flakiness_score).toBeLessThanOrEqual(1);
      }
      // The score bar is exactly 10 cells — neither truncated nor exploded.
      const bars = r.text.match(/[█░]+/g) ?? [];
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) expect(bar.length).toBe(10);
    } finally {
      await stop();
    }
  });
});

describe("contract: memory capability", () => {
  it("opt-in for the memory capability registers the three tools", async () => {
    const { registeredTools, stop } = await startInProcessServer({ capabilities: ["memory"] });
    try {
      const names = new Set(registeredTools.map((t) => t.name));
      expect(names.has("tr_get_repo_memory")).toBe(true);
      expect(names.has("tr_list_repo_memories")).toBe(true);
      expect(names.has("tr_save_repo_memory")).toBe(true);
    } finally {
      await stop();
    }
  });

  it("tr_get_repo_memory returns a digest grounded in team decisions", async () => {
    const srv = await startInProcessServer({ capabilities: ["memory"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_get_repo_memory")!;
      const result = await tool.handler({ project_id: "PROJ-1" }, srv.__ctx);
      expect(result.text).toMatch(/Team memory|No team memory/);
      const s = result.structured as { repoId?: string; digest?: string; empty?: boolean };
      expect(typeof s.digest).toBe("string");
      expect(typeof s.empty).toBe("boolean");
    } finally {
      await srv.stop();
    }
  });

  it("tr_list_repo_memories exposes test-spec mapping + stats", async () => {
    const srv = await startInProcessServer({ capabilities: ["memory"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_list_repo_memories")!;
      const result = await tool.handler({ project_id: "PROJ-1" }, srv.__ctx);
      const s = result.structured as {
        memories?: Array<{ testMatched?: boolean }>;
        stats?: { unmatchedTests?: number; mappedToTests?: number };
      };
      expect(Array.isArray(s.memories)).toBe(true);
      expect(typeof s.stats?.mappedToTests).toBe("number");
      expect(typeof s.stats?.unmatchedTests).toBe("number");
    } finally {
      await srv.stop();
    }
  });

  it("tr_save_repo_memory persists and echoes the entry", async () => {
    const srv = await startInProcessServer({ capabilities: ["memory"] });
    try {
      const tool = ALL_TOOLS.find((t) => t.name === "tr_save_repo_memory")!;
      const result = await tool.handler(
        { project_id: "PROJ-1", title: "Contract-test memory", content: "Saved by the contract suite.", category: "insight" },
        srv.__ctx,
      );
      expect(result.text).toMatch(/Saved repo memory/);
      const s = result.structured as { saved?: boolean; memory?: { id?: string } };
      expect(s.saved).toBe(true);
      expect(typeof s.memory?.id).toBe("string");
    } finally {
      await srv.stop();
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
