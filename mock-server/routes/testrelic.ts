import { Router } from "express";
import type { Request, Response } from "express";
import { mockRuns } from "../data/runs.js";
import { mockFailures } from "../data/failures.js";
import { mockFlakyTests } from "../data/flaky-tests.js";
import type { TestRun } from "../../src/types/index.js";

const router = Router();

// GET /testrelic/runs
router.get("/runs", (req: Request, res: Response) => {
  const { project_id, framework, status, cursor, limit } = req.query;
  const pageSize = Math.min(Number(limit) || 5, 20);

  let filtered = mockRuns.filter((r) => {
    if (project_id && r.project_id !== project_id) return false;
    if (framework && r.framework !== framework) return false;
    if (status && r.status !== status) return false;
    return true;
  });

  const cursorIndex = cursor ? filtered.findIndex((r) => r.run_id === cursor) + 1 : 0;
  const page = filtered.slice(cursorIndex, cursorIndex + pageSize);
  const next = cursorIndex + pageSize < filtered.length ? page[page.length - 1]?.run_id : null;

  res.json({
    data: page,
    next_cursor: next ?? null,
    total: filtered.length,
  });
});

// GET /testrelic/runs/:run_id
router.get("/runs/:run_id", (req: Request, res: Response) => {
  const run = mockRuns.find((r) => r.run_id === req.params.run_id);
  if (!run) {
    res.status(404).json({ error: `Run ${req.params.run_id} not found` });
    return;
  }
  res.json(run);
});

// GET /testrelic/runs/:run_id/failures
router.get("/runs/:run_id/failures", (req: Request, res: Response) => {
  const failures = mockFailures[req.params.run_id];
  if (!failures) {
    res.json({ run_id: req.params.run_id, failures: [] });
    return;
  }
  res.json(failures);
});

// GET /testrelic/flaky-tests
router.get("/flaky-tests", (req: Request, res: Response) => {
  const { project_id, days, threshold } = req.query;
  const minScore = threshold ? Number(threshold) : 0;

  let results = mockFlakyTests.filter((t) => {
    if (project_id && t.project_id !== project_id) return false;
    if (t.flakiness_score < minScore) return false;
    return true;
  });

  results = results.sort((a, b) => b.flakiness_score - a.flakiness_score);
  res.json({ data: results, total: results.length, days: days ?? 7 });
});

// PATCH /testrelic/tests/:test_id/dismiss-flaky
router.patch("/tests/:test_id/dismiss-flaky", (req: Request, res: Response) => {
  const test = mockFlakyTests.find((t) => t.test_id === req.params.test_id);
  if (!test) {
    res.status(404).json({ error: `Test ${req.params.test_id} not found` });
    return;
  }
  test.known_flaky = true;
  test.known_flaky_reason = req.body?.reason ?? "Marked as known flaky";
  res.json({ success: true, test_id: req.params.test_id, known_flaky: true });
});

// GET /testrelic/projects/:project_id/config
router.get("/projects/:project_id/config", (req: Request, res: Response) => {
  const configs: Record<string, object> = {
    "PROJ-1": {
      project_id: "PROJ-1",
      project_name: "Commerce Platform",
      frameworks: ["playwright"],
      integrations: { amplitude: true, loki: true, jira: true, clickhouse: true },
      created_at: "2025-09-01T00:00:00Z",
      default_branch: "main",
      alert_threshold_flakiness: 0.5,
    },
    "PROJ-2": {
      project_id: "PROJ-2",
      project_name: "Mobile API",
      frameworks: ["cypress"],
      integrations: { amplitude: true, loki: false, jira: true, clickhouse: true },
      created_at: "2025-10-15T00:00:00Z",
      default_branch: "main",
      alert_threshold_flakiness: 0.6,
    },
  };

  const config = configs[req.params.project_id];
  if (!config) {
    res.status(404).json({ error: `Project ${req.params.project_id} not found` });
    return;
  }
  res.json(config);
});

// GET /testrelic/projects/:project_id/trends
router.get("/projects/:project_id/trends", (req: Request, res: Response) => {
  const projectRuns = mockRuns.filter((r) => r.project_id === req.params.project_id);
  const trendData = projectRuns.slice(0, 7).map((r) => ({
    date: r.started_at.split("T")[0],
    pass_rate: r.total > 0 ? Math.round((r.passed / r.total) * 100) / 100 : 0,
    total_runs: r.total,
    avg_duration_ms: r.duration_ms,
    flaky_count: r.flaky,
  }));

  res.json({ project_id: req.params.project_id, period_days: 7, data: trendData });
});

// GET /testrelic/alerts/active
router.get("/alerts/active", (_req: Request, res: Response) => {
  res.json([
    {
      alert_id: "ALERT-001",
      project_id: "PROJ-1",
      type: "flakiness_spike",
      severity: "critical",
      message:
        "TEST-checkout-001 flakiness score reached 0.82 — above threshold of 0.50. Review immediately.",
      triggered_at: "2026-02-28T14:05:00Z",
      run_id: "RUN-2847",
    },
    {
      alert_id: "ALERT-002",
      project_id: "PROJ-1",
      type: "pass_rate_drop",
      severity: "warning",
      message:
        "PROJ-1 pass rate dropped to 94.6% over the last 3 runs — below baseline of 98%.",
      triggered_at: "2026-02-28T14:06:00Z",
    },
  ]);
});

// POST /testrelic/ai-rca
router.post("/ai-rca", (req: Request, res: Response) => {
  const { run_id } = req.body;
  const rcaMap: Record<string, object> = {
    "RUN-2847": {
      run_id: "RUN-2847",
      root_cause:
        "Payment gateway timeout caused by a 3rd-party API latency spike on the Stripe proxy layer. All 14 failures trace back to checkout_api.ts:142 exceeding the 30s timeout threshold during a 4-minute window starting at 14:02:48 UTC.",
      confidence: 0.87,
      affected_component: "checkout-api / payment-gateway",
      suggested_fix:
        "Increase the payment gateway timeout threshold in checkout_api.config from 30s to 45s and add a circuit breaker to fail fast when the gateway latency exceeds 5s for more than 3 consecutive requests.",
      evidence: [
        "9 of 14 failures are TimeoutError at checkout_api.ts:142",
        "Loki shows 12% error rate spike starting 14:02:48 UTC",
        "Gateway latency p99 hit 4823ms vs 2000ms threshold",
        "All timeouts resolve after 14:04:30 UTC when gateway recovered",
      ],
      generated_at: "2026-02-28T14:10:00Z",
    },
    "RUN-2849": {
      run_id: "RUN-2849",
      root_cause:
        "Redis session store connection pool exhaustion caused auth login failures. The pool was fully occupied by long-running sessions, blocking new session creation.",
      confidence: 0.79,
      affected_component: "auth-service / redis",
      suggested_fix:
        "Increase Redis connection pool size from 10 to 25 and add idle connection timeout of 30s to reclaim stale connections.",
      evidence: [
        "Loki shows redis pool=10/10 at 15:00:45 UTC",
        "Auth failures all coincide with pool exhaustion window",
      ],
      generated_at: "2026-02-28T15:10:00Z",
    },
  };

  const rca = rcaMap[run_id];
  if (!rca) {
    res.status(404).json({
      error: `No RCA available for run ${run_id}. The run may not have failures or analysis is still in progress.`,
    });
    return;
  }
  res.json(rca);
});

// POST /testrelic/suggest-fix
router.post("/suggest-fix", (req: Request, res: Response) => {
  const { run_id, test_name } = req.body;
  res.json({
    run_id,
    test_name,
    suggestion: {
      description:
        "Increase the timeout in checkout_api.config and add retry logic with exponential backoff.",
      code_diff: `// checkout_api.config.ts
- timeout: 30000,
+ timeout: 45000,
+ retryPolicy: {
+   maxRetries: 3,
+   backoffMs: 1000,
+   backoffMultiplier: 2,
+ },`,
      affected_files: ["checkout_api.config.ts", "payment-service.ts"],
      confidence: 0.84,
    },
  });
});

export default router;
