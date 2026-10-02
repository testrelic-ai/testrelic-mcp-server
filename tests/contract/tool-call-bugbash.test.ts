import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ServiceClient } from "../../packages/mcp/src/clients/http.js";
import { cloudOps, legacyAmplitudeAdapter, legacyJiraAdapter, legacyLokiAdapter, legacyTestRelicAdapter } from "../../packages/mcp/src/clients/cloud.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import { missingCoverage } from "../../packages/mcp/src/tools/impact/index.js";
import type { ToolContext, ToolDefinition } from "../../packages/mcp/src/registry/index.js";

/**
 * Tool-call bug-bash regressions, found by checking every cloud-client call
 * against cloud-platform-app's stage controllers (the TEAI-377 method).
 * Each block names the symptom a user saw.
 */

// ── A real ServiceClient against a scripted local server ─────────────────────

type Reply = { status: number; body: string; type?: string };
let server: http.Server;
let base = "";
const hits = new Map<string, number>();
const replies = new Map<string, Reply>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const r = replies.get(path) ?? { status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "nope" } }) };
    res.writeHead(r.status, { "content-type": r.type ?? "application/json" });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const client = () => new ServiceClient({ service: "cloud", baseUrl: base, timeoutMs: 5_000 });

describe("HTTP layer", () => {
  it("rejects a 200 that is the web app's HTML (CDN-rewritten 403/404) instead of passing it on as data", async () => {
    replies.set("/html", { status: 200, type: "text/html; charset=utf-8", body: "<!doctype html><html><body>app</body></html>" });
    await expect(client().get("/html")).rejects.toThrow(/web page instead of JSON/);
    expect(hits.get("/html")).toBe(1); // not retried
  });

  it("keeps the platform's own error message on a 404", async () => {
    replies.set("/missing", { status: 404, body: JSON.stringify({ error: { code: "RUN_NOT_FOUND", message: "Run r9 not found." } }) });
    await expect(client().get("/missing")).rejects.toThrow("Run r9 not found.");
  });

  it("does not retry a 5xx that carries a platform error code (a deliberate answer)", async () => {
    replies.set("/ai", { status: 503, body: JSON.stringify({ error: { code: "AI_NOT_CONFIGURED", message: "ANTHROPIC_API_KEY is not configured" } }) });
    await expect(client().get("/ai")).rejects.toThrow("ANTHROPIC_API_KEY is not configured");
    expect(hits.get("/ai")).toBe(1);
  });

  it("does not retry a 501", async () => {
    replies.set("/stub", { status: 501, body: JSON.stringify({ error: { code: "NOT_IMPLEMENTED", message: "dismiss-flaky is not implemented" } }) });
    await expect(client().get("/stub")).rejects.toThrow(/501 Not Implemented/);
    expect(hits.get("/stub")).toBe(1);
  });

  it("does not open the circuit breaker on a run of 404s", async () => {
    replies.set("/gone", { status: 404, body: "{}" });
    replies.set("/ok", { status: 200, body: JSON.stringify({ fine: true }) });
    const c = client();
    for (let i = 0; i < 6; i++) await expect(c.get("/gone")).rejects.toThrow();
    // Before: five 404s opened the circuit and blocked every cloud tool for 30 s.
    await expect(c.get("/ok")).resolves.toEqual({ fine: true });
  });
});

// ── Client adapters against stubbed routes ───────────────────────────────────

function stub(routes: Record<string, unknown>, seen: Array<{ method: string; path: string; params?: unknown; body?: unknown }> = []) {
  const reply = (method: string, url: string, extra: Record<string, unknown>) => {
    const path = url.split("?")[0]!;
    seen.push({ method, path, ...extra });
    if (!(path in routes)) throw new Error(`no stub for ${method} ${path}`);
    const v = routes[path];
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    get: async (url: string, params?: unknown) => reply("GET", url, { params }),
    post: async (url: string, body?: unknown) => reply("POST", url, { body }),
  } as unknown as ServiceClient;
}

function tool(name: string): ToolDefinition {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t;
}

const RUN = {
  runId: "r1",
  repoId: "p1",
  testFramework: "playwright",
  status: "completed",
  summary: { passed: 1, failed: 1, skipped: 0, flaky: 0 },
  startedAt: "2026-10-01T10:00:00.000Z",
  finishedAt: "2026-10-01T10:05:00.000Z",
  commit: "abc123",
};

describe("tr_ai_rca / tr_suggest_fix", () => {
  it("getAiRca rethrows so tr_ai_rca can fall back to sampling (was a fake 0% 'not available' RCA)", async () => {
    const tr = legacyTestRelicAdapter(cloudOps(stub({ "/mcp/runs/r1/rca": new Error("cloud returned 404 Not Found: Run r1 not found.") })));
    await expect(tr.getAiRca("r1")).rejects.toThrow("Run r1 not found.");
  });

  it("getAiRca rejects a body with no root_cause instead of rendering NaN% and crashing on evidence.map", async () => {
    const tr = legacyTestRelicAdapter(cloudOps(stub({ "/mcp/runs/r1/rca": { unexpected: true } })));
    await expect(tr.getAiRca("r1")).rejects.toThrow(/no RCA/);
  });

  it("suggestFix surfaces the platform's reason instead of a placeholder that reads like a result", async () => {
    const tr = legacyTestRelicAdapter(
      cloudOps(stub({ "/mcp/runs/r1/suggest-fix": new Error("cloud returned 503 Server Error: ANTHROPIC_API_KEY is not configured") })),
    );
    await expect(tr.suggestFix("r1", "t")).rejects.toThrow("ANTHROPIC_API_KEY is not configured");
  });
});

describe("tr_create_jira", () => {
  it("unwraps { issue }, maps P2 to a Jira priority name, and cleans labels (was 'Jira created — undefined')", async () => {
    const seen: Array<{ method: string; path: string; body?: unknown }> = [];
    const jira = legacyJiraAdapter(
      cloudOps(
        stub(
          { "/integrations/jira/issues": { issue: { id: "1", key: "QA-7", url: "https://x/browse/QA-7", summary: "s" } } },
          seen,
        ),
      ),
    );
    const t = await jira.createIssue({ summary: "s", priority: "P2", labels: ["testrelic", "auth spec.ts"], description: "d" });
    expect(t).toMatchObject({ key: "QA-7", url: "https://x/browse/QA-7", status: "open", priority: "High" });
    const body = seen[0]!.body as Record<string, unknown>;
    expect(body.priority).toBe("High");
    expect(body.labels).toEqual(["testrelic", "auth-spec.ts"]);
    // No project_key given → let the platform resolve the project.
    expect(body).not.toHaveProperty("project");
  });

  it("sends project only when the caller names one", async () => {
    const seen: Array<{ method: string; path: string; body?: unknown }> = [];
    const jira = legacyJiraAdapter(cloudOps(stub({ "/integrations/jira/issues": { issue: { id: "1", key: "QA-8", url: "u", summary: "s" } } }, seen)));
    await jira.createIssue({ summary: "s", priority: "P1", labels: [], project_key: "QA" });
    expect((seen[0]!.body as Record<string, unknown>).project).toBe("QA");
  });

  it("does not offer a closed ticket as the existing one (platform status slug is 'done', not 'Done')", async () => {
    const def = tool("tr_create_jira");
    const ctx = {
      clients: {
        jira: {
          findIssuesByLabel: async () => ({
            issues: [{ key: "ENG-1", summary: "old", status: "done", priority: "high", url: "u", labels: [], created_at: "" }],
            total: 1,
          }),
        },
        testrelic: legacyTestRelicAdapter(cloudOps(stub({ "/runs/r1": RUN, "/runs/r1/timeline": { steps: [] }, "/mcp/runs/r1/rca": new Error("x") }))),
        amplitude: { getUserCount: async () => { throw new Error("no amplitude"); } },
      },
    } as unknown as ToolContext;
    const res = await def.handler({ run_id: "r1", priority: "P2", dry_run: true }, ctx);
    expect(res.text).toContain("Dry run");
    expect(res.text).not.toContain("Existing Jira ticket");
  });
});

describe("tr_recent_runs pagination", () => {
  it("never sends `cursor` to the platform (any cursor switches /runs to keyset paging and restarts at page 1)", async () => {
    const seen: Array<{ method: string; path: string; params?: unknown }> = [];
    const cloud = cloudOps(stub({ "/runs": { runs: [], pagination: { page: 2, limit: 5, total: 7 } } }, seen));
    await cloud.listRuns({ cursor: "2", limit: 5 });
    const params = seen[0]!.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("cursor");
    expect(params.page).toBe(2);
  });
});

describe("tr_production_signal / tr_user_impact", () => {
  const LINES = {
    lines: [
      { timestamp: "2026-10-01T10:00:05.000Z", message: "a", labels: { level: "error" } },
      { timestamp: "2026-10-01T10:00:40.000Z", message: "b", labels: { level: "error" } },
      { timestamp: "2026-10-01T10:03:00.000Z", message: "c", labels: { level: "error" } },
    ],
    total: 3,
  };

  it("reports the busiest minute, not line-count ×100 as a percent (was '300.00%')", async () => {
    const loki = legacyLokiAdapter(cloudOps(stub({ "/integrations/loki/logs": LINES })));
    const r = await loki.queryRange('{app="x"}', "24h");
    expect(r.error_rate_peak).toBe(0);
    expect(r.peak_per_minute).toBe(2);
    expect(r.peak_time).toBe("2026-10-01T10:00:00Z");
    expect(r.truncated).toBe(false);
  });

  it("honours d/m/w windows (7d was silently queried as 24h but labelled 7d)", async () => {
    const seen: Array<{ method: string; path: string; params?: unknown }> = [];
    const loki = legacyLokiAdapter(cloudOps(stub({ "/integrations/loki/logs": LINES }, seen)));
    const before = Date.now();
    const r = await loki.queryRange('{app="x"}', "7d");
    const p = seen[0]!.params as { start: string; end: string };
    const spanDays = (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000;
    expect(spanDays).toBeCloseTo(7, 1);
    expect(r.time_range).toBe("7d");
    expect(Date.parse(p.end)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("labels an unparseable window as the 24h it actually queried", async () => {
    const loki = legacyLokiAdapter(cloudOps(stub({ "/integrations/loki/logs": LINES })));
    expect((await loki.queryRange('{app="x"}', "yesterday")).time_range).toBe("24h");
  });

  it("asks Amplitude for the run's own dates (no dates meant 20250101–20251231)", async () => {
    const seen: Array<{ method: string; path: string; params?: unknown }> = [];
    const amp = legacyAmplitudeAdapter(
      cloudOps(stub({ "/runs/r1": RUN, "/integrations/amplitude/events": { eventType: "error", points: [{ date: "2026-10-01", count: 4 }] } }, seen)),
    );
    const u = await amp.getUserCount("r1");
    const params = seen.find((s) => s.path === "/integrations/amplitude/events")!.params as Record<string, unknown>;
    expect(params).toMatchObject({ eventType: "error", start: "20261001", end: "20261001" });
    expect(u.affected_users).toBe(4);
  });

  it("tr_user_impact no longer queries someone else's checkout service; Loki needs an explicit log_query", async () => {
    let lokiCalled = false;
    const ctx = {
      clients: {
        testrelic: legacyTestRelicAdapter(cloudOps(stub({ "/runs/r1": RUN }))),
        amplitude: { getUserCount: async () => ({ run_id: "r1", affected_users: 3, peak_time: "2026-10-01", error_path: "" }) },
        loki: { queryRange: async () => { lokiCalled = true; throw new Error("unexpected"); } },
      },
    } as unknown as ToolContext;
    const res = await tool("tr_user_impact").handler({ run_id: "r1" }, ctx);
    expect(lokiCalled).toBe(false);
    expect(res.text).toContain("No `log_query` given");
    expect(res.text).not.toContain("at ``");
  });
});

describe("tr_ask_ai / tr_ai_usage / tr_marketplace_validate", () => {
  const cloudCtx = (routes: Record<string, unknown>) => ({ clients: { cloud: cloudOps(stub(routes)) } }) as unknown as ToolContext;

  it("tr_ask_ai surfaces the platform's error instead of a blank answer", async () => {
    const ctx = cloudCtx({
      "/mcp/ai/agent": { conversationId: "c1", messages: [{ role: "assistant", content: "" }], error: { code: "QUOTA_EXCEEDED", message: "Monthly AI quota reached" } },
    });
    await expect(tool("tr_ask_ai").handler({ message: "hi" }, ctx)).rejects.toThrow("Monthly AI quota reached (QUOTA_EXCEEDED)");
  });

  it("tr_ask_ai keeps a partial answer and appends why it stopped", async () => {
    const ctx = cloudCtx({
      "/mcp/ai/agent": { conversationId: "c1", messages: [{ role: "assistant", content: "Partial" }], error: { code: "CANCELLED", message: "Run cancelled" } },
    });
    const res = await tool("tr_ask_ai").handler({ message: "hi" }, ctx);
    expect(res.text).toContain("Partial");
    expect(res.text).toContain("Run cancelled");
  });

  it("tr_ai_usage says the budget isn't reported instead of 'Budget: 0 tokens'", async () => {
    const ctx = cloudCtx({ "/mcp/ai/usage": { monthlyTokenUsage: 10, monthlyTokenBudget: 0, monthlyRequestCount: 1, overLimit: false } });
    const res = await tool("tr_ai_usage").handler({}, ctx);
    expect(res.text).toContain("**Budget:** not reported");
    expect(res.text).not.toContain("**Budget:** 0");
  });

  it("tr_marketplace_validate shows the platform's `message` (was always 'validation failed')", async () => {
    const ctx = cloudCtx({ "/mcp/marketplace/apps/jira/validate": { ok: false, message: "Jira rejected the API token (401)." } });
    const res = await tool("tr_marketplace_validate").handler({ slug: "jira", credentials: { apiToken: "x" } }, ctx);
    expect(res.text).toContain("Jira rejected the API token (401).");
  });
});

describe("tr_risk_score / tr_analyze_diff / tr_heal_run", () => {
  it("missingCoverage explains why there is no score instead of letting 0% read as LOW", () => {
    expect(missingCoverage([], [], [])).toMatch(/no code map/);
    expect(missingCoverage([{}], [{ code_node_ids: [], journey_ids: [] }], [])).toMatch(/no test coverage map/);
    expect(missingCoverage([{}], [{ code_node_ids: ["n"], journey_ids: ["j"] }], [{ user_count: 0 }])).toMatch(/no user counts/);
    expect(missingCoverage([{}], [{ code_node_ids: ["n"], journey_ids: ["j"] }], [{ user_count: 5 }])).toBeNull();
  });

  it("tr_heal_run asks for the source instead of diffing against an empty file named ''", async () => {
    const ctx = {
      clients: {
        testrelic: legacyTestRelicAdapter(
          cloudOps(
            stub({
              "/runs/r1": RUN,
              "/runs/r1/timeline": { steps: [{ status: "failed", testId: "t1", testTitle: "pays", specFile: "pay.spec.ts", errorMessage: "boom" }] },
            }),
          ),
        ),
      },
    } as unknown as ToolContext;
    const res = await tool("tr_heal_run").handler({ run_id: "r1" }, ctx);
    expect(res.text).toContain("Healing needs the test source");
    expect(res.text).toContain("pay.spec.ts");
    expect(res.structured).toEqual({});
  });
});
