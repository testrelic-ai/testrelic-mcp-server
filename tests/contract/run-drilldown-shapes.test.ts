import { describe, it, expect } from "vitest";
import { cloudOps, legacyTestRelicAdapter } from "../../packages/mcp/src/clients/cloud.js";
import type { ServiceClient } from "../../packages/mcp/src/clients/http.js";

/**
 * Regression (TEAI-262): the drill-down tools (tr_diagnose_run / tr_heal_run /
 * tr_replay_failure / tr_compare_runs) silently returned `{ run: null }`,
 * reported "Run not found", or crashed with "Cannot read properties of
 * undefined (reading 'filter')" on runs that tr_recent_runs happily listed.
 *
 * Root cause: the cloud client assumed response envelopes the platform does
 * NOT send. `GET /runs/:id` returns the run object DIRECTLY (the dashboard's
 * RunResponse), not `{ run }`; `GET /runs/:id/timeline` returns `{ steps }`,
 * not `{ timeline }`. The mock server happened to use the wrapped shapes, so
 * no contract test caught the prod mismatch. These tests pin BOTH shapes.
 */

function stubClient(routes: Record<string, unknown>): ServiceClient {
  return {
    get: async (url: string) => {
      const path = url.split("?")[0];
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

const directRun = {
  runId: "r1",
  repoId: "p1",
  testFramework: "playwright",
  status: "completed",
  outcome: "failed",
  totalTests: 5,
  summary: { passed: 3, failed: 2, skipped: 0, flaky: 0 },
  duration: 1000,
  startedAt: "2026-06-29T00:00:00.000Z",
  finishedAt: "2026-06-29T00:00:01.000Z",
  branch: "main",
  commit: "abc123",
};

describe("cloud client tolerates the platform's real run-detail shapes", () => {
  it("getRun resolves a run returned DIRECTLY (no { run } envelope) — the prod shape", async () => {
    const cloud = cloudOps(stubClient({ "/runs/r1": directRun }));
    const run = await cloud.getRun("r1");
    expect(run.run_id).toBe("r1");
    expect(run.failed).toBe(2);
    expect(run.framework).toBe("playwright");
  });

  it("getRun still resolves the legacy { run } envelope", async () => {
    const cloud = cloudOps(stubClient({ "/runs/r2": { run: { ...directRun, runId: "r2" } } }));
    const run = await cloud.getRun("r2");
    expect(run.run_id).toBe("r2");
  });

  it("getRun throws a clean not-found when the body carries no run", async () => {
    const cloud = cloudOps(stubClient({ "/runs/missing": {} }));
    await expect(cloud.getRun("missing")).rejects.toThrow(/not found/i);
  });

  it("getRunFailures reads a { steps } timeline (prod shape) without crashing", async () => {
    const tr = legacyTestRelicAdapter(
      cloudOps(
        stubClient({
          "/runs/r1/timeline": {
            steps: [
              { status: "failed", title: "Stage create persists", testId: "a", error: { type: "AssertionError", message: "boom" } },
              { status: "passed", title: "noop", testId: "b" },
            ],
            total: 2,
            runId: "r1",
          },
        }),
      ),
    );
    const { failures } = await tr.getRunFailures("r1");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.test_name).toBe("Stage create persists");
    expect(failures[0]?.error_type).toBe("AssertionError");
  });

  it("getRunFailures still reads a { timeline } shape", async () => {
    const tr = legacyTestRelicAdapter(
      cloudOps(stubClient({ "/runs/r1/timeline": { timeline: [{ status: "failed", title: "T", testId: "a" }] } })),
    );
    const { failures } = await tr.getRunFailures("r1");
    expect(failures).toHaveLength(1);
  });

  it("getRunFailures returns no failures (no crash) when the timeline endpoint errors", async () => {
    const tr = legacyTestRelicAdapter(
      cloudOps(stubClient({ "/runs/r1/timeline": new Error("502 upstream") })),
    );
    const { failures } = await tr.getRunFailures("r1");
    expect(failures).toEqual([]);
  });
});
