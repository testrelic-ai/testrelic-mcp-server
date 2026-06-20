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

// ── /api/v1/mcp/ai/* ───────────────────────────────────────────────────────
// Mirror cloud-platform-app's Ask AI surface for --mock-mode.

const MOCK_AI_TOOL_CATALOG = [
  {
    name: "query_test_runs",
    category: "testing",
    description: "Query test runs from the database with optional filters.",
    output: "text",
    inputSchema: { type: "object", properties: { repoName: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "generate_dashboard",
    category: "artifacts",
    description: "Produce a dashboard artifact (widget array).",
    output: "artifact",
    artifactType: "dashboard",
    inputSchema: { type: "object", properties: { title: { type: "string" }, widgets: { type: "array" } } },
  },
  {
    name: "generate_report",
    category: "artifacts",
    description: "Produce a markdown report artifact with structured sections.",
    output: "artifact",
    artifactType: "report",
    inputSchema: { type: "object", properties: { title: { type: "string" }, sections: { type: "array" } } },
  },
];

router.get("/mcp/ai/tools", (_req: Request, res: Response) => {
  res.json({ catalog: MOCK_AI_TOOL_CATALOG });
});

router.post("/mcp/ai/tools/:toolName/execute", (req: Request, res: Response) => {
  const tool = req.params.toolName;
  const entry = MOCK_AI_TOOL_CATALOG.find((t) => t.name === tool);
  if (!entry) return res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: `unknown tool ${tool}` } });
  if (entry.output === "artifact") {
    return res.json({
      result: {},
      artifact: {
        id: `art-mock-${tool}-1`,
        type: entry.artifactType,
        payload: { title: `Mock ${entry.artifactType}`, generatedAt: new Date().toISOString() },
      },
    });
  }
  res.json({ result: { tool, mock: true, note: "deterministic mock response" } });
});

router.post("/mcp/ai/agent", (req: Request, res: Response) => {
  const body = req.body as { messages?: Array<{ role: string; content: string }>; conversationId?: string };
  const userMsg = body.messages?.find((m) => m.role === "user")?.content ?? "(empty)";
  res.json({
    conversationId: body.conversationId ?? "conv-mock-1",
    messages: [
      { role: "user", content: userMsg },
      {
        role: "assistant",
        content: `Mock reply to: "${userMsg.slice(0, 80)}"`,
        artifacts: [{ id: "art-mock-1", type: "dashboard", payload: { title: "Mock dashboard" } }],
      },
    ],
    usage: { inputTokens: 100, outputTokens: 200 },
  });
});

router.get("/mcp/ai/conversations", (_req: Request, res: Response) => {
  res.json({
    conversations: [
      { id: "conv-mock-1", title: "Flaky tests last week", createdAt: "2026-04-01T00:00:00Z", updatedAt: "2026-04-02T00:00:00Z", messageCount: 4 },
      { id: "conv-mock-2", title: "Coverage gaps review", createdAt: "2026-04-03T00:00:00Z", updatedAt: "2026-04-03T00:00:00Z", messageCount: 2 },
    ],
    nextCursor: null,
  });
});

router.post("/mcp/ai/conversations", (req: Request, res: Response) => {
  const body = req.body as { title?: string };
  res.json({ id: "conv-mock-new", title: body.title ?? "New Chat" });
});

router.get("/mcp/ai/conversations/:id", (req: Request, res: Response) => {
  res.json({
    id: req.params.id,
    title: "Mock conversation",
    messages: [
      { id: "m-1", role: "user", content: "Hello?", createdAt: "2026-04-01T00:00:00Z" },
      { id: "m-2", role: "assistant", content: "Hi! How can I help with your tests today?", createdAt: "2026-04-01T00:00:01Z" },
    ],
  });
});

router.delete("/mcp/ai/conversations/:id", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.get("/mcp/ai/artifacts", (_req: Request, res: Response) => {
  res.json({
    artifacts: [
      { id: "art-mock-1", type: "dashboard", title: "Mock dashboard", createdAt: "2026-04-01T00:00:00Z", conversationId: "conv-mock-1" },
      { id: "art-mock-2", type: "report", title: "Mock report", createdAt: "2026-04-02T00:00:00Z", conversationId: "conv-mock-1" },
    ],
    nextCursor: null,
  });
});

router.get("/mcp/ai/artifacts/:id", (req: Request, res: Response) => {
  res.json({
    id: req.params.id,
    type: "dashboard",
    title: "Mock dashboard",
    payload: { title: "Mock dashboard", widgets: [{ id: "w1", type: "stat", label: "Pass rate", value: "97%" }] },
    createdAt: "2026-04-01T00:00:00Z",
  });
});

router.post("/mcp/ai/artifacts/:id/export", (req: Request, res: Response) => {
  const body = req.body as { format?: "png" | "pdf" };
  res.json({
    url: `http://localhost:4000/mock-artifact-export/${req.params.id}.${body.format ?? "pdf"}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
});

router.get("/mcp/ai/usage", (_req: Request, res: Response) => {
  res.json({ monthlyTokenUsage: 125_000, monthlyTokenBudget: 1_000_000, monthlyRequestCount: 73, overLimit: false });
});

// ── /api/v1/mcp/marketplace/* ──────────────────────────────────────────────

const MOCK_MARKETPLACE_APPS = [
  { slug: "jira", name: "Jira", category: "ticketing", description: "Create and link Jira issues.", authMethod: "basic", requiresOAuth: false, capabilities: ["jira.search", "jira.create", "jira.status"], connected: true, comingSoon: false, docsUrl: "https://support.atlassian.com/jira-software-cloud" },
  { slug: "github-actions", name: "GitHub Actions", category: "ci", description: "Trigger workflows and view runs.", authMethod: "pat", requiresOAuth: false, capabilities: ["github.runs", "github.logs", "github.trigger"], connected: false, comingSoon: false, docsUrl: "https://docs.github.com/en/actions" },
  { slug: "amplitude", name: "Amplitude", category: "analytics", description: "Map test paths to user journeys.", authMethod: "apikey", requiresOAuth: false, capabilities: ["amplitude.events", "amplitude.paths"], connected: true, comingSoon: false, docsUrl: "https://amplitude.com/docs/apis/analytics/dashboard-rest" },
];

router.get("/mcp/marketplace/apps", (_req: Request, res: Response) => {
  res.json({ apps: MOCK_MARKETPLACE_APPS });
});

router.get("/mcp/marketplace/apps/:slug", (req: Request, res: Response) => {
  const app = MOCK_MARKETPLACE_APPS.find((a) => a.slug === req.params.slug);
  if (!app) return res.status(404).json({ error: { code: "APP_NOT_FOUND" } });
  res.json({
    ...app,
    configFields: [
      { key: "apiKey", label: "API Key", placeholder: "Enter API key", secret: true },
    ],
  });
});

router.get("/mcp/marketplace/connections", (_req: Request, res: Response) => {
  res.json({
    connections: MOCK_MARKETPLACE_APPS
      .filter((a) => a.connected)
      .map((a) => ({ slug: a.slug, status: "connected", connectedAt: "2025-09-15T00:00:00Z" })),
  });
});

router.post("/mcp/marketplace/apps/:slug/validate", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post("/mcp/marketplace/apps/:slug/connect", (req: Request, res: Response) => {
  res.json({ ok: true, id: `int-mock-${req.params.slug}` });
});

router.post("/mcp/marketplace/apps/:slug/oauth/start", (req: Request, res: Response) => {
  res.json({
    redirectUrl: `http://localhost:4000/mock-oauth/${req.params.slug}/authorize`,
    state: "mock-state-token",
  });
});

router.delete("/mcp/marketplace/apps/:slug", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post("/mcp/marketplace/apps/:slug/invoke", (req: Request, res: Response) => {
  const body = req.body as { operation?: string; args?: Record<string, unknown> };
  res.json({
    ok: true,
    operation: body.operation ?? "",
    result: { slug: req.params.slug, args: body.args, mock: true },
  });
});

// ── /api/v1/mcp/apps/* (Connected Apps gateway — branded as "Apps" only) ──

const MOCK_APPS = [
  { slug: "slack", name: "Slack", category: "app", connected: true, connectionId: "conn-mock-slack" },
  { slug: "notion", name: "Notion", category: "app", connected: false, connectionId: null },
  { slug: "linear", name: "Linear", category: "app", connected: false, connectionId: null },
];

const MOCK_APP_ACTIONS: Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> = {
  slack: [
    { name: "send_message", description: "Send a message to a channel.", inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } } },
    { name: "list_channels", description: "List channels.", inputSchema: { type: "object", properties: {} } },
  ],
  notion: [
    { name: "create_page", description: "Create a page.", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } } } },
  ],
  linear: [
    { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", properties: { title: { type: "string" }, teamId: { type: "string" } } } },
  ],
};

router.get("/mcp/apps", (_req: Request, res: Response) => {
  res.json({ apps: MOCK_APPS });
});

router.get("/mcp/apps/:slug", (req: Request, res: Response) => {
  const app = MOCK_APPS.find((a) => a.slug === req.params.slug);
  if (!app) return res.status(404).json({ error: { code: "APP_NOT_FOUND" } });
  res.json(app);
});

router.get("/mcp/apps/:slug/actions", (req: Request, res: Response) => {
  const actions = MOCK_APP_ACTIONS[req.params.slug] ?? [];
  res.json({ actions });
});

router.get("/mcp/apps/connections", (_req: Request, res: Response) => {
  res.json({
    connections: MOCK_APPS
      .filter((a) => a.connected)
      .map((a) => ({ id: a.connectionId!, app: a.slug, status: "ACTIVE" })),
  });
});

router.post("/mcp/apps/:slug/connect", (req: Request, res: Response) => {
  res.json({
    redirectUrl: `http://localhost:4000/mock-oauth/apps/${req.params.slug}/authorize`,
    connectionId: `conn-mock-${req.params.slug}-${Date.now()}`,
  });
});

router.get("/mcp/apps/connections/:connectionId", (req: Request, res: Response) => {
  res.json({ id: req.params.connectionId, app: "unknown", status: "ACTIVE" });
});

router.delete("/mcp/apps/connections/:connectionId", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.post("/mcp/apps/execute", (req: Request, res: Response) => {
  const body = req.body as { app?: string; action?: string; args?: Record<string, unknown> };
  res.json({
    ok: true,
    app: body.app ?? "",
    action: body.action ?? "",
    result: { args: body.args, mock: true, note: "deterministic mock action result" },
  });
});

// ── /api/v1/mcp/* — filled stubs ──────────────────────────────────────────

router.get("/mcp/runs/:runId/rca", (req: Request, res: Response) => {
  res.json({
    run_id: req.params.runId,
    root_cause: "Mock RCA: timeout on /api/checkout endpoint",
    confidence: 0.82,
    affected_component: "checkout-service",
    suggested_fix: "Increase timeout or add retry with backoff",
    evidence: ["3 failing tests share the same stack frame", "Loki shows error rate spike at 12:04 UTC"],
    generated_at: new Date().toISOString(),
  });
});

router.post("/mcp/runs/:runId/suggest-fix", (req: Request, res: Response) => {
  const body = req.body as { test_name?: string };
  res.json({
    run_id: req.params.runId,
    test_name: body.test_name ?? "",
    suggestion: {
      description: "Mock fix: wait for visible state before clicking",
      code_diff: "@@ -1 +1 @@\n-await page.click('#submit')\n+await page.getByRole('button', { name: 'Submit' }).click()",
      affected_files: ["tests/checkout.spec.ts"],
      confidence: 0.78,
    },
  });
});

router.post("/mcp/tests/:testId/dismiss-flaky", (req: Request, res: Response) => {
  res.json({ success: true, test_id: req.params.testId, known_flaky: true });
});

router.get("/mcp/repos/:repoId/code-map", (_req: Request, res: Response) => {
  res.json({
    data: [
      { id: "node-1", type: "function", name: "checkout", file_path: "src/checkout/index.ts" },
      { id: "node-2", type: "class", name: "CartService", file_path: "src/cart/service.ts" },
    ],
  });
});

router.get("/mcp/integrations/amplitude/sessions", (req: Request, res: Response) => {
  const runId = String(req.query.runId ?? "");
  res.json({
    run_id: runId,
    total: 2,
    sessions: [
      { session_id: "sess-1", user_id: "user-1", started_at: "2026-04-01T12:00:00Z", events: ["page_view", "checkout_started"] },
      { session_id: "sess-2", user_id: "user-2", started_at: "2026-04-01T12:05:00Z", events: ["page_view", "error"] },
    ],
  });
});

router.get("/mcp/repos/:repoId/trends", (req: Request, res: Response) => {
  res.json({
    project_id: req.params.repoId,
    period_days: Number(req.query.days) || 30,
    data: [
      // Match the real getRepoTrends payload (cloud-platform-app
      // mcp-stubs.controller.ts): passRate is a 0–100 PERCENTAGE, flakiness a
      // 0–100 score, durationMs is milliseconds, and each bucket carries totalRuns.
      { date: "2026-04-01", passRate: 95.0, flakiness: 3.0, durationMs: 45000, totalRuns: 12 },
      { date: "2026-04-02", passRate: 97.0, flakiness: 2.0, durationMs: 43000, totalRuns: 15 },
      { date: "2026-04-03", passRate: 96.0, flakiness: 2.0, durationMs: 44000, totalRuns: 11 },
    ],
  });
});

router.get("/mcp/alerts/active", (_req: Request, res: Response) => {
  res.json([
    { id: "alert-1", type: "flakiness_spike", severity: "warning", message: "Flakiness 18% (>15% threshold)", created_at: "2026-04-03T08:00:00Z" },
  ]);
});

export default router;
