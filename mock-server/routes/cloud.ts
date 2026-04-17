import { Router } from "express";
import type { Request, Response } from "express";
import { mockRuns } from "../data/runs.js";
import { mockFailures } from "../data/failures.js";
import {
  mockJourneys,
  mockTestMap,
  mockCodeMap,
  computeCoverageGaps,
} from "../data/journeys.js";
import { mockFlakyTests } from "../data/flaky-tests.js";
import { mockLokiResponses } from "../data/loki-logs.js";

/**
 * Mock implementation of the cloud-platform-app `/api/v1/*` surface the MCP
 * talks to. Routes match cloud-platform-app/server/src/routes/* 1:1 so tests
 * (and `--mock-mode`) can exercise the same code paths the real platform
 * serves.
 */

const router = Router();

const MOCK_USER = { id: "u-mock", email: "dev@testrelic.local", name: "Mock Dev", onboardingDone: true };
const MOCK_ORG = { id: "org-mock", name: "Mock Org", plan: "growth" };

// ── /api/v1/mcp/bootstrap ──────────────────────────────────────────────────
router.get("/mcp/bootstrap", (_req: Request, res: Response) => {
  const repos = Array.from(new Set(mockRuns.map((r) => r.project_id))).map((id) => ({
    id,
    gitId: `testrelic/${id.toLowerCase()}`,
    displayName: id === "PROJ-1" ? "Commerce Platform" : id === "PROJ-2" ? "Mobile API" : id,
    createdAt: "2025-09-01T00:00:00Z",
  }));
  res.json({
    user: MOCK_USER,
    organization: MOCK_ORG,
    integrations: [
      { type: "jira", name: "Jira (mock)", status: "connected", connected: true, capabilities: ["jira.search", "jira.create", "jira.status"], connectedAt: "2025-09-02T00:00:00Z" },
      { type: "amplitude", name: "Amplitude (mock)", status: "connected", connected: true, capabilities: ["amplitude.events", "amplitude.paths"], connectedAt: "2025-09-03T00:00:00Z" },
      { type: "grafana-loki", name: "Grafana Loki (mock)", status: "connected", connected: true, capabilities: ["loki.query"], connectedAt: "2025-09-04T00:00:00Z" },
    ],
    repos,
    server: { apiBaseUrl: "http://localhost:4000/api/v1", version: "mock-1.0.0" },
  });
});

// ── /api/v1/mcp/flakiness ──────────────────────────────────────────────────
router.get("/mcp/flakiness", (req: Request, res: Response) => {
  const window = Number(req.query.window) || 7;
  const repoId = String(req.query.repoId ?? "");
  const src = repoId ? mockFlakyTests.filter((t) => t.project_id === repoId) : mockFlakyTests;
  res.json({
    window,
    scores: src.map((t) => ({
      testId: t.test_id,
      testTitle: t.test_name,
      suite: t.suite,
      repoId: t.project_id,
      flakyRuns: t.failure_count,
      totalRuns: t.failure_count + t.pass_count,
      score: Math.round(t.flakiness_score * 100),
      updatedAt: t.last_seen,
    })),
  });
});

// ── /api/v1/repos ──────────────────────────────────────────────────────────
router.get("/repos", (_req: Request, res: Response) => {
  const repos = Array.from(new Set(mockRuns.map((r) => r.project_id))).map((id) => ({
    id,
    gitId: `testrelic/${id.toLowerCase()}`,
    displayName: id === "PROJ-1" ? "Commerce Platform" : id === "PROJ-2" ? "Mobile API" : id,
    totalRuns: mockRuns.filter((r) => r.project_id === id).length,
    lastRunStatus: mockRuns.find((r) => r.project_id === id)?.status ?? null,
    lastRunSummary: null,
    passRate: 0.97,
    flakyRate: 0.02,
  }));
  res.json({ repos });
});

// ── /api/v1/repos/:repoId/runs ─────────────────────────────────────────────
router.get("/repos/:repoId/runs", (req: Request, res: Response) => {
  const repoId = req.params.repoId;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const filtered = mockRuns.filter((r) => r.project_id === repoId);
  const start = (page - 1) * limit;
  const slice = filtered.slice(start, start + limit);
  const runs = slice.map((r) => ({
    runId: r.run_id,
    id: r.run_id,
    repoId: r.project_id,
    branch: r.branch,
    commit: r.commit_sha,
    status: r.status === "passed" ? "completed" : r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    duration: r.duration_ms,
    totalTests: r.total,
    summary: { passed: r.passed, failed: r.failed, skipped: r.skipped, flaky: r.flaky },
    testFramework: r.framework,
  }));
  res.json({ runs, pagination: { page, limit, total: filtered.length } });
});

// ── /api/v1/runs?repoId=&page= ─────────────────────────────────────────────
router.get("/runs", (req: Request, res: Response) => {
  const repoId = String(req.query.repoId ?? "");
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const filtered = repoId ? mockRuns.filter((r) => r.project_id === repoId) : mockRuns;
  const start = (page - 1) * limit;
  const slice = filtered.slice(start, start + limit);
  const runs = slice.map((r) => ({
    runId: r.run_id,
    id: r.run_id,
    repoId: r.project_id,
    branch: r.branch,
    commit: r.commit_sha,
    status: r.status === "passed" ? "completed" : r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    duration: r.duration_ms,
    totalTests: r.total,
    summary: { passed: r.passed, failed: r.failed, skipped: r.skipped, flaky: r.flaky },
    testFramework: r.framework,
  }));
  res.json({ runs, pagination: { page, limit, total: filtered.length } });
});

// ── /api/v1/runs/:runId ────────────────────────────────────────────────────
router.get("/runs/:runId", (req: Request, res: Response) => {
  const r = mockRuns.find((x) => x.run_id === req.params.runId);
  if (!r) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `Run ${req.params.runId} not found` } });
    return;
  }
  res.json({
    run: {
      runId: r.run_id,
      id: r.run_id,
      repoId: r.project_id,
      branch: r.branch,
      commit: r.commit_sha,
      status: r.status === "passed" ? "completed" : r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      duration: r.duration_ms,
      totalTests: r.total,
      summary: { passed: r.passed, failed: r.failed, skipped: r.skipped, flaky: r.flaky },
      testFramework: r.framework,
    },
  });
});

// ── /api/v1/runs/:runId/timeline ───────────────────────────────────────────
router.get("/runs/:runId/timeline", (req: Request, res: Response) => {
  const failures = mockFailures[req.params.runId];
  if (!failures) {
    res.json({ timeline: [] });
    return;
  }
  const timeline = failures.failures.map((f) => ({
    testId: f.test_id,
    title: f.test_name,
    suite: f.suite,
    status: "failed",
    durationMs: f.duration_ms,
    retry: f.retry_count,
    error: { type: f.error_type, message: f.error_message, stack: f.stack_trace },
  }));
  res.json({ timeline });
});

// ── /api/v1/repos/:repoId/runs/:runId/tests ────────────────────────────────
router.get("/repos/:repoId/runs/:runId/tests", (req: Request, res: Response) => {
  const { runId } = req.params;
  const run = mockRuns.find((r) => r.run_id === runId);
  const failures = mockFailures[runId];
  const tests = (failures?.failures ?? []).map((f) => ({
    testId: f.test_id,
    title: f.test_name,
    suite: f.suite,
    status: "failed",
    durationMs: f.duration_ms,
    retry: f.retry_count,
    failure: {
      errorType: f.error_type,
      errorMessage: f.error_message,
      stackTrace: f.stack_trace,
      videoUrl: f.video_url,
      screenshotUrl: f.screenshot_url,
    },
  }));
  res.json({
    runId,
    total: run?.total ?? tests.length,
    passed: run?.passed ?? 0,
    failed: run?.failed ?? tests.length,
    skipped: run?.skipped ?? 0,
    branch: run?.branch ?? null,
    commit: run?.commit_sha ?? null,
    tests,
  });
});

// ── /api/v1/repos/:repoId/runs/:runId/tests/:testId ────────────────────────
router.get("/repos/:repoId/runs/:runId/tests/:testId", (req: Request, res: Response) => {
  const { runId, testId } = req.params;
  const run = mockRuns.find((r) => r.run_id === runId);
  const failures = mockFailures[runId];
  const fail = failures?.failures.find((f) => f.test_id === testId);
  if (!fail || !run) {
    res.status(404).json({ error: { code: "NOT_FOUND" } });
    return;
  }
  res.json({
    test: {
      testId: fail.test_id,
      title: fail.test_name,
      suite: fail.suite,
      status: "failed",
      durationMs: fail.duration_ms,
      retry: fail.retry_count,
      isFlaky: false,
      failure: {
        errorType: fail.error_type,
        errorMessage: fail.error_message,
        stackTrace: fail.stack_trace,
        videoUrl: fail.video_url,
        screenshotUrl: fail.screenshot_url,
      },
    },
    run: {
      runId: run.run_id,
      id: run.run_id,
      repoId: run.project_id,
      branch: run.branch,
      commit: run.commit_sha,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      duration: run.duration_ms,
      totalTests: run.total,
      summary: { passed: run.passed, failed: run.failed },
    },
    steps: [],
    consoleLogs: [],
    networkRequests: [],
  });
});

// ── /api/v1/repos/:repoId/navigation ───────────────────────────────────────
router.get("/repos/:repoId/navigation", (req: Request, res: Response) => {
  const { repoId } = req.params;
  const journeys = mockJourneys[repoId] ?? [];
  const edges = journeys.map((j) => ({
    id: j.id,
    name: j.name,
    sequence: j.events,
    users: j.user_count,
    sessions: j.session_count,
    lastSeen: j.last_seen,
  }));
  res.json({ repoId, edges });
});

// ── /api/v1/repos/:repoId/test-impact ──────────────────────────────────────
router.get("/repos/:repoId/test-impact", (req: Request, res: Response) => {
  const { repoId } = req.params;
  const tests = (mockTestMap[repoId] ?? []).map((t) => ({
    testId: t.test_id,
    title: t.test_name,
    suite: t.suite,
    journeyIds: t.journey_ids,
    codeNodeIds: t.code_node_ids,
    tags: t.tags ?? [],
    filePath: t.source_file,
  }));
  const journeys = mockJourneys[repoId] ?? [];
  const covered = new Set<string>();
  for (const t of mockTestMap[repoId] ?? []) for (const j of t.journey_ids) covered.add(j);
  const userTotal = journeys.reduce((s, j) => s + j.user_count, 0) || 1;
  const gaps = computeCoverageGaps(repoId, 20).map((g) => ({
    journeyId: g.journey_id,
    name: g.journey_name,
    userCount: g.user_count,
    sessionCount: g.session_count,
    events: g.events,
    coverageGain: g.pp_coverage_gain,
  }));
  const codeMap = mockCodeMap[repoId] ?? [];
  const coveredNodes = new Set<string>();
  for (const t of mockTestMap[repoId] ?? []) for (const n of t.code_node_ids) coveredNodes.add(n);
  res.json({
    repoId,
    calculation: {
      userCoverage: journeys.length > 0 ? (covered.size / journeys.length) * 100 : 0,
      testCoverage: codeMap.length > 0 ? (coveredNodes.size / codeMap.length) * 100 : 0,
      userTotal,
    },
    tests,
    gaps,
  });
});

// ── /api/v1/o2/session/:sessionId/user-journeys ────────────────────────────
router.get("/o2/session/:sessionId/user-journeys", (_req: Request, res: Response) => {
  res.json({ alignments: [], providerConnected: true });
});

// ── /api/v1/o2/session/:sessionId/user-impact ──────────────────────────────
router.get("/o2/session/:sessionId/user-impact", (_req: Request, res: Response) => {
  res.json({ summary: { totalUniqueUsers: 0, totalRequests: 0, totalErrors: 0 }, criticalFlows: [] });
});

// ── /api/v1/o2/analyze/session/:sessionId ──────────────────────────────────
router.post("/o2/analyze/session/:sessionId", (_req: Request, res: Response) => {
  res.json({
    journeyAlignment: [],
    gapAnalysis: [],
    globalMetrics: { totalUniqueUsers: 0, totalRequests: 0, totalErrors: 0, overallErrorRate: "0%" },
    lokiLogGroups: [],
  });
});

// ── /api/v1/integrations ───────────────────────────────────────────────────
router.get("/integrations", (_req: Request, res: Response) => {
  res.json({
    integrations: [
      { id: "int-jira", type: "jira", name: "Jira", status: "connected", config: { instance: "mock.atlassian.net", email: "dev@testrelic.local" }, connectedAt: "2025-09-01T00:00:00Z" },
      { id: "int-amp", type: "amplitude", name: "Amplitude", status: "connected", config: {}, connectedAt: "2025-09-01T00:00:00Z" },
      { id: "int-loki", type: "grafana-loki", name: "Grafana Loki", status: "connected", config: { url: "https://mock-loki.testrelic.local" }, connectedAt: "2025-09-01T00:00:00Z" },
    ],
  });
});

router.get("/integrations/status/:type", (req: Request, res: Response) => {
  res.json({ connected: true, valid: true, type: req.params.type });
});

// ── /api/v1/integrations/jira/search ───────────────────────────────────────
router.get("/integrations/jira/search", (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").toLowerCase();
  const issues = [
    { key: "ENG-101", summary: "Checkout timeout investigation", status: "In Progress", priority: "P2", url: "https://mock.atlassian.net/browse/ENG-101", labels: ["regression", q], created: "2026-02-20T00:00:00Z" },
  ];
  res.json({ issues, total: issues.length });
});

router.get("/integrations/jira/issues", (_req: Request, res: Response) => {
  res.json({ issues: [], total: 0 });
});

router.post("/integrations/jira/issues", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { summary?: string; priority?: string; labels?: string[] };
  res.status(201).json({
    key: "MOCK-" + Math.floor(Math.random() * 9000 + 1000),
    summary: body.summary ?? "",
    status: "To Do",
    priority: body.priority ?? "P3",
    url: "https://mock.atlassian.net/browse/MOCK-1234",
    labels: body.labels ?? [],
    created: new Date().toISOString(),
  });
});

// ── /api/v1/integrations/amplitude/events ──────────────────────────────────
router.get("/integrations/amplitude/events", (req: Request, res: Response) => {
  const eventType = String(req.query.eventType ?? "pageview");
  const points = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.now() - (6 - i) * 86400_000).toISOString().slice(0, 10),
    count: 1000 + i * 120,
  }));
  res.json({ eventType, points });
});

router.get("/integrations/amplitude/paths", (_req: Request, res: Response) => {
  res.status(501).json({ data: null, reason: "funnel_params_required" });
});

// ── /api/v1/integrations/loki/logs ─────────────────────────────────────────
router.get("/integrations/loki/logs", (req: Request, res: Response) => {
  const q = String(req.query.query ?? "");
  const resp = mockLokiResponses[q] ?? Object.values(mockLokiResponses)[0];
  const lines = (resp?.log_lines ?? []).map((l) => ({
    timestamp: l.timestamp,
    message: l.message,
    labels: { service: l.service, level: l.level },
  }));
  res.json({ lines, total: lines.length });
});

export default router;
