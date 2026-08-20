import { describe, it, expect } from "vitest";
import {
  cloudOps,
  legacyAmplitudeAdapter,
  legacyClickhouseAdapter,
  legacyJiraAdapter,
  legacyLokiAdapter,
} from "../../packages/mcp/src/clients/cloud.js";
import { TestRelicMcpError } from "../../packages/mcp/src/errors.js";
import type { ServiceClient } from "../../packages/mcp/src/clients/http.js";

/**
 * Regression (TEAI-376): `tr_production_signal` failed 100% of the time against
 * prod with `Internal error in tr_production_signal: Cannot read properties of
 * undefined (reading 'map')`.
 *
 * Root cause: the integration-proxy adapters treat a resolved promise as a
 * shape guarantee. `platform.testrelic.ai`'s CloudFront distribution rewrites
 * BOTH 403 and 404 into `200 /index.html` distribution-wide (`/api/*`
 * included), so an origin 404 — e.g. `INTEGRATION_NOT_CONFIGURED` when
 * grafana-loki is not connected — arrives as a 200 carrying an HTML string.
 * axios resolves it, the adapters' `.catch()` fallbacks never fire, and
 * `r.lines.map(...)` throws a bare TypeError naming neither tool nor cause.
 *
 * Same class as TEAI-262 ("reading 'filter'") — see run-drilldown-shapes.test.ts.
 * These tests pin every integration-proxy adapter against an off-shape 200.
 */

/** What CloudFront hands back when it swallows an origin 403/404. */
const MASKED_404 = `<!doctype html><html><head><title>TestRelic</title></head><body><div id="root"></div></body></html>`;

function stubClient(routes: Record<string, unknown>): ServiceClient {
  return {
    get: async (url: string) => {
      const path = url.split("?")[0]!;
      if (!(path in routes)) throw new Error(`no stub for ${path}`);
      const v = routes[path];
      if (v instanceof Error) throw v;
      return v;
    },
    post: async () => {
      throw new Error("no post stub");
    },
  } as unknown as ServiceClient;
}

describe("legacyLokiAdapter survives a CloudFront-masked 4xx", () => {
  it("throws a typed UpstreamError — never a bare TypeError — on a 200 with no `lines`", async () => {
    const loki = legacyLokiAdapter(cloudOps(stubClient({ "/integrations/loki/logs": MASKED_404 })));

    await expect(loki.queryRange('{service="checkout"}', "24h")).rejects.toThrow(TestRelicMcpError);
    await expect(loki.queryRange('{service="checkout"}', "24h")).rejects.not.toThrow(TypeError);

    const err = await loki.queryRange('{service="checkout"}', "24h").catch((e: Error) => e);
    expect(err.message).not.toMatch(/reading 'map'/);
    expect(err.message).toMatch(/lines/);
    expect(err.message).toMatch(/CloudFront|not connected/i);
  });

  it("also rejects a JSON error envelope served with a 200", async () => {
    const loki = legacyLokiAdapter(
      cloudOps(
        stubClient({
          "/integrations/loki/logs": { error: { code: "INTEGRATION_NOT_CONFIGURED", message: "not connected" } },
        }),
      ),
    );
    await expect(loki.queryRange("{}", "1h")).rejects.toThrow(TestRelicMcpError);
  });

  it("does NOT swallow a real upstream failure into a clean production signal", async () => {
    const loki = legacyLokiAdapter(
      cloudOps(stubClient({ "/integrations/loki/logs": new Error("cloud returned 404 Not Found") })),
    );
    // Previously `.catch(() => ({ lines: [], total: 0 }))` reported "Total
    // errors: 0" for a query that never ran — a silent false all-clear.
    await expect(loki.queryRange("{}", "1h")).rejects.toThrow(/404/);
  });

  it("maps the real platform shape `{ lines, total }` correctly", async () => {
    const loki = legacyLokiAdapter(
      cloudOps(
        stubClient({
          "/integrations/loki/logs": {
            lines: [
              { timestamp: "2026-08-04T12:00:00.000Z", message: "boom", labels: { service: "checkout", level: "error" } },
            ],
            total: 1,
          },
        }),
      ),
    );
    const r = await loki.queryRange('{service="checkout"}', "24h");
    expect(r.log_lines).toHaveLength(1);
    expect(r.log_lines[0]).toMatchObject({ service: "checkout", level: "error", message: "boom" });
    expect(r.total_errors).toBe(1);
    expect(r.time_range).toBe("24h");
  });

  it("treats a genuinely empty result as success, not as drift", async () => {
    const loki = legacyLokiAdapter(cloudOps(stubClient({ "/integrations/loki/logs": { lines: [], total: 0 } })));
    const r = await loki.queryRange("{}", "1h");
    expect(r.log_lines).toEqual([]);
    expect(r.total_errors).toBe(0);
  });
});

describe("the sibling integration-proxy adapters degrade instead of crashing", () => {
  it("legacyJiraAdapter.findIssuesByLabel returns [] on an off-shape 200", async () => {
    const jira = legacyJiraAdapter(cloudOps(stubClient({ "/integrations/jira/search": MASKED_404 })));
    await expect(jira.findIssuesByLabel("flaky")).resolves.toEqual({ issues: [], total: 0 });
  });

  it("legacyClickhouseAdapter.queryFlakinessScores returns [] on an off-shape 200", async () => {
    const ch = legacyClickhouseAdapter(cloudOps(stubClient({ "/mcp/flakiness": MASKED_404 })));
    await expect(ch.queryFlakinessScores("run-1")).resolves.toEqual({ data: [], rows: 0 });
  });

  it("legacyAmplitudeAdapter.getUserCount returns 0 affected users on an off-shape 200", async () => {
    const amp = legacyAmplitudeAdapter(cloudOps(stubClient({ "/integrations/amplitude/events": MASKED_404 })));
    const r = await amp.getUserCount("run-1");
    expect(r.affected_users).toBe(0);
  });

  it("still maps well-formed payloads", async () => {
    const jira = legacyJiraAdapter(
      cloudOps(
        stubClient({
          "/integrations/jira/search": {
            issues: [
              { key: "TEAI-1", summary: "s", status: "Open", priority: "High", url: "u", labels: ["flaky"], created: "2026-08-04T00:00:00.000Z" },
            ],
            total: 1,
          },
        }),
      ),
    );
    const r = await jira.findIssuesByLabel("flaky");
    expect(r.total).toBe(1);
    expect(r.issues[0]?.key).toBe("TEAI-1");

    const ch = legacyClickhouseAdapter(
      cloudOps(
        stubClient({
          "/mcp/flakiness": {
            window: 7,
            scores: [
              { testId: "t1", testTitle: "checkout", suite: "s", repoId: "p1", flakyRuns: 2, totalRuns: 10, score: 20, updatedAt: "2026-08-04T00:00:00.000Z" },
            ],
          },
        }),
      ),
    );
    const c = await ch.queryFlakinessScores("run-1");
    expect(c.rows).toBe(1);
    expect(c.data[0]?.flakiness_score).toBeCloseTo(0.2);
  });
});
