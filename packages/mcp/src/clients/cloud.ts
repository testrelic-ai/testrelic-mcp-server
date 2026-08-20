import { UpstreamError } from "../errors.js";
import type { ServiceClient } from "./http.js";
import type {
  ActiveAlert,
  AmplitudeSession,
  AmplitudeUserCount,
  CodeNode,
  CoverageGap,
  CoverageReport,
  FlakinessQueryResult,
  FlakyTest,
  JiraTicket,
  LokiQueryResponse,
  PaginatedResponse,
  ProjectConfig,
  ProjectTrends,
  RunFailuresResponse,
  TestFailure,
  TestCoverageEntry,
  TestRun,
  UserJourney,
} from "../types/index.js";

/**
 * v2 "cloud" client — the single client through which the MCP reaches
 * everything. Maps 1:1 to cloud-platform-app `/api/v1/*` routes. The platform
 * proxies to Jira / Amplitude / Loki / GitHub server-side using the user's
 * stored integration credentials, so we never hold third-party secrets here.
 *
 * The legacy per-service ops files (amplitude / loki / jira / clickhouse /
 * testrelic) remain as thin adapter shims that delegate to CloudOps so the
 * tools that still reference them keep working.
 */

// ── Bootstrap ───────────────────────────────────────────────────────────────

export interface BootstrapResponse {
  user: { id: string; email: string; name: string; onboardingDone: boolean };
  organization: { id: string; name: string; plan: string };
  integrations: Array<{
    type: string;
    name: string;
    status: string;
    connected: boolean;
    capabilities: string[];
    connectedAt: string;
  }>;
  repos: Array<{
    id: string;
    gitId: string;
    displayName: string;
    createdAt: string;
  }>;
  server: { apiBaseUrl: string; version: string };
}

export interface FlakinessRow {
  testId: string;
  testTitle: string;
  suite: string;
  repoId: string;
  flakyRuns: number;
  totalRuns: number;
  score: number;
  updatedAt: string;
}

export interface FlakinessResponse {
  window: number;
  scores: FlakinessRow[];
}

/**
 * The platform's `/mcp/flakiness` returns `score` as a 0–100 integer
 * percentage (see FlakinessRow), while every internal consumer
 * (`FlakyTest.flakiness_score`, threshold inputs, the score-bar rendering)
 * works in 0–1 fractions. Divide by 100 to convert.
 *
 * NOT a `>1 ? /100 : n` heuristic: that was ambiguous at the boundary — a real
 * score of 1 (i.e. 1% flaky) fell into the `else` branch and rendered as 1.0
 * (100%), reporting the mildest non-zero-flaky test as maximally flaky. The
 * source contract is unambiguously 0–100, so a straight divide is correct for
 * every value; the clamp guards a malformed out-of-range score. (Original
 * symptom that motivated this normalization: a score of 82 reached
 * `"░".repeat(10 - 820)` and threw `Invalid count value: -810`.)
 */
export function toFraction(score: number): number {
  const n = Number.isFinite(score) ? score : 0;
  return Math.min(1, Math.max(0, n / 100));
}

// ── Platform response shapes we parse into legacy types ─────────────────────

interface PlatformRepo {
  id: string;
  gitId: string;
  displayName: string;
  defaultBranch?: string;
  totalRuns?: number;
  lastRunStatus?: string | null;
  lastRunSummary?: Record<string, unknown> | null;
  passRate?: number;
  flakyRate?: number;
}

interface PlatformRun {
  runId: string;
  id: string;
  repoId: string;
  branch: string | null;
  commit: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  duration: number | null;
  totalTests: number | null;
  summary: { passed?: number; failed?: number; skipped?: number; flaky?: number } | null;
  testFramework?: string;
  /** Derived pass/fail result ("passed" | "failed" | "incomplete"), distinct
   *  from the lifecycle `status`. Present on platforms that compute it. */
  outcome?: string | null;
}

interface PlatformTestResult {
  testId: string;
  title: string;
  suite: string;
  status: string;
  durationMs: number;
  retry?: number;
  runId?: string;
  isFlaky?: boolean;
  failure?: {
    errorType?: string;
    errorMessage?: string;
    stackTrace?: string;
    videoUrl?: string;
    screenshotUrl?: string;
  };
}

interface PlatformRunTests {
  runId: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  branch?: string | null;
  commit?: string | null;
  tests: PlatformTestResult[];
}

interface PlatformLokiLog {
  timestamp: string;
  message: string;
  labels?: Record<string, string>;
}

interface PlatformLokiResponse {
  lines: PlatformLokiLog[];
  total: number;
}

interface PlatformAmplitudePoint {
  date: string;
  count: number;
}

interface PlatformAmplitudeEvents {
  eventType: string;
  points: PlatformAmplitudePoint[];
}

interface PlatformJiraIssue {
  key: string;
  summary: string;
  status: string;
  priority: string;
  url: string;
  labels?: string[];
  created?: string;
}

interface PlatformJiraSearch {
  issues: PlatformJiraIssue[];
  total: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map a platform run onto the MCP RunStatus. Prefers the server's derived
 * pass/fail OUTCOME so a run with failures is never reported "passed" (the
 * lifecycle `status` is just in_progress → completed). Falls back to the
 * per-test failed counter, then the lifecycle status. An 'incomplete' outcome
 * (aborted / partial upload) surfaces as 'cancelled' — never 'passed'. TEAI-224.
 */
function toRunStatus(r: PlatformRun): TestRun["status"] {
  if (r.outcome === "passed" || r.outcome === "failed") return r.outcome;
  if (r.outcome === "incomplete") return "cancelled";
  if ((r.summary?.failed ?? 0) > 0) return "failed";
  if (r.status === "completed") return "passed";
  if (r.status === "in_progress" || r.status === "running") return "running";
  // r.status is an unconstrained platform string; only pass through values that
  // are valid MCP RunStatuses, else default to "running" rather than forcing an
  // out-of-contract string into the union via an unchecked cast.
  if (r.status === "passed" || r.status === "failed" || r.status === "cancelled") return r.status;
  return "running";
}

function toRun(r: PlatformRun): TestRun {
  const s = r.summary ?? {};
  return {
    run_id: r.runId,
    project_id: r.repoId,
    framework: r.testFramework ?? "unknown",
    status: toRunStatus(r),
    total: r.totalTests ?? 0,
    passed: s.passed ?? 0,
    failed: s.failed ?? 0,
    skipped: s.skipped ?? 0,
    flaky: s.flaky ?? 0,
    duration_ms: r.duration ?? 0,
    started_at: r.startedAt,
    finished_at: r.finishedAt ?? r.startedAt,
    branch: r.branch ?? "",
    commit_sha: r.commit ?? "",
    triggered_by: "",
  };
}

function toJiraTicket(i: PlatformJiraIssue): JiraTicket {
  return {
    key: i.key,
    summary: i.summary,
    status: i.status,
    priority: i.priority,
    url: i.url,
    labels: i.labels ?? [],
    created_at: i.created ?? new Date(0).toISOString(),
  };
}

/**
 * Read a collection out of an upstream payload WITHOUT assuming the 200 that
 * carried it is actually the shape we asked for.
 *
 * A resolved promise is not a shape guarantee. `platform.testrelic.ai` sits
 * behind a CloudFront distribution whose SPA custom error responses rewrite
 * BOTH 403 and 404 into `200 /index.html`, distribution-wide — `/api/*`
 * included. So "grafana-loki is not connected" (an origin 404) reaches this
 * process as a 200 carrying an HTML *string*, axios resolves it, and the
 * `.catch()` fallbacks below never fire. Indexing straight into `.lines` /
 * `.issues` / `.scores` then throws a bare `TypeError: Cannot read properties
 * of undefined (reading 'map')` that names neither the tool nor the cause
 * (TEAI-376; same class as TEAI-262's "reading 'filter'").
 *
 * Returns `undefined` when the key is not an array, so callers can tell
 * "upstream said zero rows" apart from "upstream did not answer in our
 * vocabulary" — those two must never render the same.
 */
/**
 * Project ONE timeline row onto a `TestFailure`.
 *
 * The platform's row is a `TimelineStepResponse` (shared/types/run.ts):
 * `testTitle`, `errorMessage`, `stackTrace`, `duration`, `specFile` — it has no
 * nested `error` object, no `durationMs`, no `retry` and no `suite`. Reading the
 * client-side names alone produced a failure list with the right COUNT and blank
 * everything else: no test name, `error_type` permanently "Error", empty message.
 * The mock and even the "(prod shape)" regression test used the client's names,
 * so nothing caught it — the envelope was fixed in TEAI-262 and the rows were not.
 *
 * Platform names are read FIRST, with the legacy/mock names kept as fallbacks so
 * an older upstream (and the fixtures that mimic it) still resolve.
 */
function toFailure(t: Record<string, unknown>): TestFailure {
  const err = t.error as Record<string, unknown> | undefined;
  const status = String(t.status ?? "").toLowerCase();
  const message = String(t.errorMessage ?? err?.message ?? "");
  return {
    test_id: String(t.testId ?? t.id ?? ""),
    // `action` is the step label — the last resort when a row carries no test title.
    test_name: String(t.testTitle ?? t.title ?? t.name ?? t.action ?? ""),
    suite: String(t.suite ?? t.specFile ?? ""),
    // The platform sends no error TYPE. Infer the one thing that is knowable
    // rather than labelling a timeout "Error".
    error_type: String(err?.type ?? (status === "timedout" ? "TimeoutError" : "Error")),
    error_message: message,
    stack_trace: String(t.stackTrace ?? err?.stack ?? ""),
    duration_ms: Number(t.durationMs ?? t.duration ?? 0),
    retry_count: Number(t.retry ?? 0),
    video_url: "",
    // `videoOffset` is SECONDS from the start of the recording (and null on
    // backfilled rows); this field is milliseconds.
    video_timestamp_ms: t.videoOffset == null ? 0 : Number(t.videoOffset) * 1000,
    screenshot_url: String(t.screenshotUrl ?? ""),
  };
}

/**
 * Timeline rows are STEPS, not test cases: one failing test can contribute
 * several failed actions, which previously rendered as several "failures" for
 * the same test. Collapse per test and keep the most informative row — the one
 * that actually carries an error message.
 */
function dedupeFailuresByTest(failures: TestFailure[]): TestFailure[] {
  const byTest = new Map<string, TestFailure>();
  const out: TestFailure[] = [];
  for (const f of failures) {
    // No test id and no name — nothing to collapse on; keep it as its own row
    // rather than merging unrelated steps under an empty key.
    const key = f.test_id || f.test_name;
    if (!key) {
      out.push(f);
      continue;
    }
    const seen = byTest.get(key);
    if (!seen) {
      byTest.set(key, f);
      out.push(f);
      continue;
    }
    if (!seen.error_message && f.error_message) {
      Object.assign(seen, f);
    }
  }
  return out;
}

function collection<T>(payload: unknown, key: string): T[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as T[]) : undefined;
}

/** Same idea for a scalar count: trust the row count over an absent/garbage `total`. */
function countOr(payload: unknown, key: string, fallback: number): number {
  if (typeof payload !== "object" || payload === null) return fallback;
  const n = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(n) ? n : fallback;
}

// ── CloudOps ────────────────────────────────────────────────────────────────

export function cloudOps(client: ServiceClient) {
  return {
    // ── Bootstrap & discovery ────────────────────────────────────────────
    bootstrap(): Promise<BootstrapResponse> {
      return client.get("/mcp/bootstrap");
    },
    getFlakiness(repoId?: string, window = 7): Promise<FlakinessResponse> {
      return client.get("/mcp/flakiness", { repoId, window });
    },
    integrationStatus(type: string): Promise<{ connected: boolean; valid: boolean; error?: string }> {
      return client.get(`/integrations/status/${type}`);
    },
    listIntegrations(): Promise<{ integrations: Array<{ type: string; status: string; config: Record<string, unknown>; connectedAt: string }> }> {
      return client.get("/integrations");
    },

    // ── Repos & runs ─────────────────────────────────────────────────────
    async listRepos(): Promise<PlatformRepo[]> {
      const r = await client.get<{ repos: PlatformRepo[] }>("/repos");
      return r.repos ?? [];
    },
    async listRuns(params: {
      project_id?: string;
      framework?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    }): Promise<PaginatedResponse<TestRun>> {
      // "project_id" is a platform repoId — falls back to /runs (org-wide).
      const { project_id, status, ...rest } = params;
      const page = params.cursor ? parseInt(params.cursor, 10) : 1;
      const q: Record<string, unknown> = { ...rest, page };
      // The MCP RunStatus (passed|failed|running|cancelled) is a derived OUTCOME
      // for passed/failed but a lifecycle value for running. The platform filters
      // on `outcome` (passed|failed|incomplete) and lifecycle `status` separately,
      // so route each value to the right query param — otherwise status=failed
      // matches nothing (every run's lifecycle status is "completed"). TEAI-226.
      if (status === "passed" || status === "failed") q.outcome = status;
      // 'cancelled' is how an 'incomplete' outcome surfaces on the read path
      // (toRunStatus), so route the filter to the same outcome — otherwise the
      // platform's lifecycle status never holds 'cancelled' and matches nothing.
      else if (status === "cancelled") q.outcome = "incomplete";
      else if (status === "running") q.status = "in_progress";
      else if (status) q.status = status;
      if (project_id) {
        const r = await client.get<{ runs: PlatformRun[]; pagination: { page: number; limit: number; total: number } }>(
          `/repos/${encodeURIComponent(project_id)}/runs`,
          q,
        );
        const runs = (r.runs ?? []).map(toRun);
        const total = r.pagination?.total ?? runs.length;
        const next = (r.pagination?.page ?? 1) * (r.pagination?.limit ?? runs.length) < total
          ? String((r.pagination?.page ?? 1) + 1)
          : null;
        return { data: runs, total, next_cursor: next };
      }
      const r = await client.get<{ runs: PlatformRun[]; pagination: { page: number; limit: number; total: number } }>(
        "/runs",
        q,
      );
      const runs = (r.runs ?? []).map(toRun);
      const total = r.pagination?.total ?? runs.length;
      const next = (r.pagination?.page ?? 1) * (r.pagination?.limit ?? runs.length) < total
        ? String((r.pagination?.page ?? 1) + 1)
        : null;
      return { data: runs, total, next_cursor: next };
    },
    async getRun(runId: string): Promise<TestRun> {
      // GET /runs/:id returns the run object DIRECTLY (the dashboard's
      // RunResponse); some shapes wrap it as { run }. Tolerate BOTH so a real
      // (e.g. SDK-uploaded) run resolves instead of surfacing a phantom
      // "not found" when only the direct shape is sent (TEAI-262).
      const r = await client.get<{ run?: PlatformRun } & Partial<PlatformRun>>(
        `/runs/${encodeURIComponent(runId)}`,
      );
      const raw = (r?.run ?? r) as PlatformRun | undefined;
      // Guard a missing run record so callers get a clean "not found" rather than
      // a null-deref inside toRun (the TEAI-223 crash: reading 'summary' of
      // undefined). Tools wrap getRun in try/catch and surface a friendly message.
      if (!raw?.runId) {
        throw new Error(`Run ${runId} not found`);
      }
      return toRun(raw);
    },
    async getRunTests(repoId: string, runId: string): Promise<PlatformRunTests> {
      return client.get<PlatformRunTests>(
        `/repos/${encodeURIComponent(repoId)}/runs/${encodeURIComponent(runId)}/tests`,
      );
    },
    async getTestDetail(repoId: string, runId: string, testId: string): Promise<{
      test: PlatformTestResult;
      run: PlatformRun;
      steps?: Array<{ title: string; durationMs: number }>;
      consoleLogs?: Array<Record<string, unknown>>;
      networkRequests?: Array<Record<string, unknown>>;
    }> {
      return client.get(
        `/repos/${encodeURIComponent(repoId)}/runs/${encodeURIComponent(runId)}/tests/${encodeURIComponent(testId)}`,
      );
    },
    async getRunTimeline(runId: string): Promise<{ timeline: Array<Record<string, unknown>> }> {
      // GET /runs/:id/timeline returns { steps, total, runId } — NOT { timeline }.
      // Normalize to { timeline } (accepting either field name) so downstream
      // callers never read `undefined.filter(...)` when only `steps` is present (TEAI-262).
      const r = await client.get<Record<string, unknown>>(
        `/runs/${encodeURIComponent(runId)}/timeline`,
      );
      const rows = (r?.timeline ?? r?.steps ?? []) as Array<Record<string, unknown>>;
      return { timeline: Array.isArray(rows) ? rows : [] };
    },
    getRunArtifacts(runId: string): Promise<{ run_id: string; artifacts: Array<{ kind: string; url: string; note?: string }> }> {
      return client.get(`/runs/${encodeURIComponent(runId)}/artifacts`);
    },

    // ── Coverage / journeys ──────────────────────────────────────────────
    getRepoNavigation(repoId: string): Promise<Record<string, unknown>> {
      return client.get(`/repos/${encodeURIComponent(repoId)}/navigation`);
    },
    getTestImpact(repoId: string): Promise<Record<string, unknown>> {
      return client.get(`/repos/${encodeURIComponent(repoId)}/test-impact`);
    },
    getSessionJourneys(sessionId: string): Promise<{
      alignments: Array<Record<string, unknown>>;
      providerConnected: boolean;
    }> {
      return client.get(`/o2/session/${encodeURIComponent(sessionId)}/user-journeys`);
    },
    getSessionUserImpact(sessionId: string): Promise<{ summary: Record<string, unknown>; criticalFlows: Array<Record<string, unknown>> }> {
      return client.get(`/o2/session/${encodeURIComponent(sessionId)}/user-impact`);
    },
    analyzeSession(sessionId: string): Promise<Record<string, unknown>> {
      return client.post(`/o2/analyze/session/${encodeURIComponent(sessionId)}`);
    },

    // ── Integration proxies (secrets never leave the platform) ───────────
    amplitudeEvents(params: { eventType?: string; start?: string; end?: string; urlFilter?: string }): Promise<PlatformAmplitudeEvents> {
      return client.get("/integrations/amplitude/events", params as Record<string, unknown>);
    },
    lokiLogs(params: { query: string; start?: string; end?: string; limit?: number }): Promise<PlatformLokiResponse> {
      return client.get("/integrations/loki/logs", params as Record<string, unknown>);
    },
    jiraSearch(params: { q: string; repoId?: string }): Promise<PlatformJiraSearch> {
      return client.get("/integrations/jira/search", params as Record<string, unknown>);
    },
    jiraListIssues(params: { jql?: string; repoId?: string }): Promise<PlatformJiraSearch> {
      return client.get("/integrations/jira/issues", params as Record<string, unknown>);
    },
    jiraCreateIssue(body: {
      summary: string;
      priority: string;
      labels: string[];
      description?: string;
      projectKey?: string;
    }): Promise<PlatformJiraIssue> {
      return client.post("/integrations/jira/issues", body);
    },

    // ── Ask AI surface (mcp:ai) ──────────────────────────────────────────
    /**
     * Catalog of every AI tool the platform exposes for execution via
     * `/mcp/ai/tools/:name/execute`. Returns input schemas so the MCP client
     * can validate args before calling.
     */
    listAiTools(): Promise<{ catalog: Array<{
      name: string;
      category: string;
      description: string;
      output: "text" | "artifact";
      artifactType?: string;
      inputSchema: Record<string, unknown>;
    }> }> {
      return client.get("/mcp/ai/tools");
    },
    executeAiTool(name: string, input: Record<string, unknown>): Promise<{
      result: Record<string, unknown>;
      artifact?: { id?: string; type: string; payload: Record<string, unknown> };
    }> {
      return client.post(`/mcp/ai/tools/${encodeURIComponent(name)}/execute`, { input });
    },
    runAgent(body: {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      conversationId?: string;
      repoId?: string;
      runId?: string;
      maxToolRounds?: number;
    }): Promise<{
      conversationId: string;
      messages: Array<{ role: string; content: string; artifacts?: Record<string, unknown>[] }>;
      usage?: { inputTokens: number; outputTokens: number };
    }> {
      return client.post("/mcp/ai/agent", body);
    },
    listConversations(params?: { cursor?: string; limit?: number }): Promise<{
      conversations: Array<{ id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }>;
      nextCursor: string | null;
    }> {
      return client.get("/mcp/ai/conversations", params as Record<string, unknown> | undefined);
    },
    getConversation(id: string): Promise<{
      id: string;
      title: string;
      messages: Array<{ id: string; role: string; content: string; artifacts?: Record<string, unknown>[]; createdAt: string }>;
    }> {
      return client.get(`/mcp/ai/conversations/${encodeURIComponent(id)}`);
    },
    createConversation(body: { title?: string; repoId?: string }): Promise<{ id: string; title: string }> {
      return client.post("/mcp/ai/conversations", body);
    },
    deleteConversation(id: string): Promise<{ ok: true }> {
      return client.delete(`/mcp/ai/conversations/${encodeURIComponent(id)}`);
    },
    listArtifacts(params?: {
      conversationId?: string;
      repoId?: string;
      type?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      artifacts: Array<{ id: string; type: string; title: string; createdAt: string; conversationId: string }>;
      nextCursor: string | null;
    }> {
      return client.get("/mcp/ai/artifacts", params as Record<string, unknown> | undefined);
    },
    getArtifact(id: string): Promise<{
      id: string;
      type: string;
      title: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }> {
      return client.get(`/mcp/ai/artifacts/${encodeURIComponent(id)}`);
    },
    exportArtifact(id: string, format: "png" | "pdf"): Promise<{ url: string; expiresAt: string }> {
      return client.post(`/mcp/ai/artifacts/${encodeURIComponent(id)}/export`, { format });
    },
    getAiUsage(): Promise<{
      monthlyTokenUsage: number;
      monthlyTokenBudget: number;
      monthlyRequestCount: number;
      overLimit: boolean;
    }> {
      return client.get("/mcp/ai/usage");
    },

    // ── Repo Memory surface (writes need the mcp:memory PAT scope) ───────
    listRepoMemories(repoId: string, params?: {
      testId?: string;
      category?: string;
      status?: string;
      search?: string;
      limit?: number;
    }): Promise<{
      memories: Array<{
        id: string;
        testId: string | null;
        title: string;
        content: string;
        category: string;
        source: string;
        status: string;
        conversationId: string | null;
        createdAt: string;
        updatedAt: string;
        testMatched: boolean;
        testTitle: string | null;
      }>;
      total: number;
      stats: {
        total: number;
        byCategory: Record<string, number>;
        mappedToTests: number;
        unmatchedTests: number;
      };
    }> {
      return client.get(`/repos/${encodeURIComponent(repoId)}/memory`, params as Record<string, unknown> | undefined);
    },
    getRepoMemoryDigest(repoId: string): Promise<{
      repoId: string;
      digest: string;
      empty: boolean;
    }> {
      return client.get(`/repos/${encodeURIComponent(repoId)}/memory/digest`);
    },
    createRepoMemory(repoId: string, body: {
      title: string;
      content: string;
      category?: string;
      testId?: string;
    }): Promise<{
      memory: {
        id: string;
        testId: string | null;
        title: string;
        content: string;
        category: string;
        source: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      };
    }> {
      return client.post(`/repos/${encodeURIComponent(repoId)}/memory`, body);
    },

    // ── Marketplace surface (mcp:marketplace) ────────────────────────────
    // `comingSoon` is OPTIONAL on the wire: the platform's catalog only
    // serialises the flag when it is true, so most rows arrive without it.
    // Callers must default it — see tr_marketplace_list_apps.
    listMarketplaceApps(): Promise<{
      apps: Array<{
        slug: string;
        name: string;
        category: string;
        description: string;
        authMethod: string;
        requiresOAuth: boolean;
        capabilities: string[];
        connected: boolean;
        comingSoon?: boolean;
        docsUrl: string;
      }>;
    }> {
      return client.get("/mcp/marketplace/apps");
    },
    getMarketplaceApp(slug: string): Promise<{
      slug: string;
      name: string;
      category: string;
      description: string;
      authMethod: string;
      requiresOAuth: boolean;
      capabilities: string[];
      connected: boolean;
      configFields: Array<{ key: string; label: string; placeholder: string; helperText?: string; secret?: boolean }>;
      docsUrl: string;
    }> {
      return client.get(`/mcp/marketplace/apps/${encodeURIComponent(slug)}`);
    },
    listMarketplaceConnections(): Promise<{
      connections: Array<{ slug: string; status: string; connectedAt: string }>;
    }> {
      return client.get("/mcp/marketplace/connections");
    },
    validateMarketplaceApp(slug: string, credentials: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
      return client.post(`/mcp/marketplace/apps/${encodeURIComponent(slug)}/validate`, { credentials });
    },
    connectMarketplaceApp(slug: string, credentials: Record<string, string>): Promise<{ ok: boolean; id: string }> {
      return client.post(`/mcp/marketplace/apps/${encodeURIComponent(slug)}/connect`, { credentials });
    },
    startMarketplaceOAuth(slug: string): Promise<{ redirectUrl: string; state: string }> {
      return client.post(`/mcp/marketplace/apps/${encodeURIComponent(slug)}/oauth/start`, {});
    },
    disconnectMarketplaceApp(slug: string): Promise<{ ok: true }> {
      return client.delete(`/mcp/marketplace/apps/${encodeURIComponent(slug)}`);
    },
    invokeMarketplaceApp(slug: string, operation: string, args: Record<string, unknown>): Promise<{
      ok: boolean;
      operation: string;
      result: Record<string, unknown>;
    }> {
      return client.post(`/mcp/marketplace/apps/${encodeURIComponent(slug)}/invoke`, { operation, args });
    },

    // ── Connected Apps surface (mcp:apps) ────────────────────────────────
    // Every method's response is renamed on the platform side so no third-party
    // gateway brand name leaks. The CloudOps types use only "app" / "action".
    listApps(): Promise<{
      apps: Array<{ slug: string; name: string; category: string; connected: boolean; connectionId: string | null }>;
    }> {
      return client.get("/mcp/apps");
    },
    getApp(slug: string): Promise<{
      slug: string;
      name: string;
      category: string;
      connected: boolean;
      connectionId: string | null;
    }> {
      return client.get(`/mcp/apps/${encodeURIComponent(slug)}`);
    },
    listAppActions(slug: string): Promise<{
      actions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    }> {
      return client.get(`/mcp/apps/${encodeURIComponent(slug)}/actions`);
    },
    listAppConnections(): Promise<{
      connections: Array<{ id: string; app: string; status: string }>;
    }> {
      return client.get("/mcp/apps/connections");
    },
    startAppConnect(slug: string): Promise<{ redirectUrl: string; connectionId: string }> {
      return client.post(`/mcp/apps/${encodeURIComponent(slug)}/connect`, {});
    },
    getAppConnection(connectionId: string): Promise<{ id: string; app: string; status: string }> {
      return client.get(`/mcp/apps/connections/${encodeURIComponent(connectionId)}`);
    },
    disconnectAppConnection(connectionId: string): Promise<{ ok: true }> {
      return client.delete(`/mcp/apps/connections/${encodeURIComponent(connectionId)}`);
    },
    appExecute(body: { app: string; action: string; args: Record<string, unknown> }): Promise<{
      ok: boolean;
      app: string;
      action: string;
      result: Record<string, unknown>;
    }> {
      return client.post("/mcp/apps/execute", body);
    },

    // ── Newly-exposed stubs (now backed by real endpoints) ───────────────
    getAiRcaV2(runId: string): Promise<{
      run_id: string;
      root_cause: string;
      confidence: number;
      affected_component: string;
      suggested_fix: string;
      evidence: string[];
      generated_at: string;
    }> {
      return client.get(`/mcp/runs/${encodeURIComponent(runId)}/rca`);
    },
    suggestFixV2(runId: string, body: { test_name: string }): Promise<{
      run_id: string;
      test_name: string;
      suggestion: { description: string; code_diff: string; affected_files: string[]; confidence: number };
    }> {
      return client.post(`/mcp/runs/${encodeURIComponent(runId)}/suggest-fix`, body);
    },
    dismissFlakyV2(testId: string, body: { reason: string }): Promise<{
      success: boolean;
      test_id: string;
      known_flaky: boolean;
    }> {
      return client.post(`/mcp/tests/${encodeURIComponent(testId)}/dismiss-flaky`, body);
    },
    getCodeMapV2(repoId: string): Promise<{ data: Array<{ id: string; type: string; name: string; file_path: string }> }> {
      return client.get(`/mcp/repos/${encodeURIComponent(repoId)}/code-map`);
    },
    getAmplitudeSessionsV2(runId: string, limit = 50): Promise<{
      run_id: string;
      sessions: Array<{ session_id: string; user_id?: string; started_at: string; events: string[] }>;
      total: number;
    }> {
      return client.get(`/mcp/integrations/amplitude/sessions`, { runId, limit });
    },
    getProjectTrendsV2(repoId: string, days = 30): Promise<{
      project_id: string;
      period_days: number;
      data: Array<{ date: string; passRate: number; flakiness: number; durationMs: number; totalRuns?: number }>;
    }> {
      return client.get(`/mcp/repos/${encodeURIComponent(repoId)}/trends`, { days });
    },
    getActiveAlertsV2(): Promise<Array<{ id: string; type: string; severity: string; message: string; created_at: string }>> {
      return client.get("/mcp/alerts/active");
    },
  };
}

export type CloudOps = ReturnType<typeof cloudOps>;

// ── Adapters used by legacy per-service ops (keeps old tools compiling) ────

export function legacyTestRelicAdapter(cloud: CloudOps) {
  /**
   * Adapter exposing the v1 TestRelicOps surface on top of CloudOps. This
   * keeps existing tools compiling while we migrate them to `cloud` directly.
   * Endpoints that are not yet served by the platform (e.g. /ai-rca, /journeys
   * as computed resources) fall back to mockable synthesis.
   */
  return {
    listRuns: (p: {
      project_id?: string;
      framework?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    }) => cloud.listRuns(p),
    getRun: (runId: string) => cloud.getRun(runId),
    async getRunFailures(runId: string): Promise<RunFailuresResponse> {
      // Synthesize failures by asking the platform for run tests across all repos.
      // We don't know repoId here; use org-wide timeline as a fallback.
      const timeline = await cloud.getRunTimeline(runId).catch(() => ({ timeline: [] as Array<Record<string, unknown>> }));
      // Defensive: getRunTimeline already normalizes to an array, but never let a
      // malformed shape reach `.filter` (this was the "Cannot read properties of
      // undefined (reading 'filter')" crash in tr_replay_failure — TEAI-262).
      const rows = Array.isArray(timeline?.timeline) ? timeline.timeline : [];
      // A timed-out test is a failure the caller cares about, and the platform
      // normalizes Playwright's `timedOut` to `timedout` — filtering on "failed"
      // alone silently dropped them.
      const FAILED = new Set(["failed", "timedout"]);
      const failures = rows
        .filter((t) => FAILED.has(String(t.status ?? "").toLowerCase()))
        .map((t) => toFailure(t));
      return { run_id: runId, failures: dedupeFailuresByTest(failures) };
    },
    async getFlakyTests(p: { project_id?: string; days?: number; threshold?: number }): Promise<{
      data: FlakyTest[];
      total: number;
      days: number;
    }> {
      const res = await cloud.getFlakiness(p.project_id, p.days ?? 7);
      // Compare fractions to fractions — the raw platform score is 0–100, the
      // tool's `threshold` input is documented 0–1.
      const filtered = res.scores.filter((s) => toFraction(s.score) >= (p.threshold ?? 0));
      return {
        data: filtered.map((s) => ({
          test_id: s.testId,
          test_name: s.testTitle,
          suite: s.suite,
          project_id: s.repoId,
          flakiness_score: toFraction(s.score),
          failure_count: s.flakyRuns,
          pass_count: Math.max(0, s.totalRuns - s.flakyRuns),
          last_seen: s.updatedAt,
          first_seen: s.updatedAt,
          known_flaky: false,
        })),
        total: filtered.length,
        days: res.window,
      };
    },
    async dismissFlakyTest(test_id: string, reason: string): Promise<{
      success: boolean;
      test_id: string;
      known_flaky: boolean;
    }> {
      try {
        return await cloud.dismissFlakyV2(test_id, { reason });
      } catch {
        // Platform hasn't shipped /mcp/tests/:id/dismiss-flaky yet. Surface
        // clean failure so the MCP client sees ok:false rather than 5xx.
        return { success: false, test_id, known_flaky: false };
      }
    },
    async getProjectConfig(project_id: string): Promise<ProjectConfig> {
      const bs = await cloud.bootstrap();
      const repo = bs.repos.find((r) => r.id === project_id || r.gitId === project_id);
      const intByType: Record<string, boolean> = {};
      for (const i of bs.integrations) intByType[i.type] = i.connected;
      return {
        project_id: repo?.id ?? project_id,
        project_name: repo?.displayName ?? project_id,
        frameworks: [],
        integrations: {
          amplitude: !!intByType["amplitude"],
          loki: !!intByType["grafana-loki"],
          jira: !!intByType["jira"],
          clickhouse: false,
        },
        created_at: repo?.createdAt ?? new Date(0).toISOString(),
        default_branch: "main",
        alert_threshold_flakiness: 15,
      };
    },
    async getProjectTrends(project_id: string, days = 30): Promise<ProjectTrends> {
      try {
        const v2 = await cloud.getProjectTrendsV2(project_id, days);
        return {
          project_id: v2.project_id,
          period_days: v2.period_days,
          data: v2.data.map((d) => ({
            date: d.date,
            pass_rate: d.passRate,
            total_runs: d.totalRuns ?? 0,
            avg_duration_ms: d.durationMs,
            // `flakiness` is a 0–100 score, not a count — carry it as a
            // percentage (matches pass_rate's convention), do not relabel it
            // as a test count.
            flakiness_pct: d.flakiness,
          })),
        };
      } catch {
        return { project_id, period_days: days, data: [] };
      }
    },
    async getActiveAlerts(): Promise<ActiveAlert[]> {
      try {
        const alerts = await cloud.getActiveAlertsV2();
        return alerts.map((a) => ({
          alert_id: a.id,
          project_id: "",
          type: a.type as ActiveAlert["type"],
          severity: a.severity as ActiveAlert["severity"],
          message: a.message,
          triggered_at: a.created_at,
        }));
      } catch {
        return [];
      }
    },
    async getAiRca(run_id: string): Promise<{
      run_id: string;
      root_cause: string;
      confidence: number;
      affected_component: string;
      suggested_fix: string;
      evidence: string[];
      generated_at: string;
    }> {
      try {
        return await cloud.getAiRcaV2(run_id);
      } catch {
        return {
          run_id,
          root_cause: "RCA endpoint not yet available on cloud-platform-app",
          confidence: 0,
          affected_component: "",
          suggested_fix: "",
          evidence: [],
          generated_at: new Date().toISOString(),
        };
      }
    },
    async suggestFix(run_id: string, test_name: string): Promise<{
      run_id: string;
      test_name: string;
      suggestion: { description: string; code_diff: string; affected_files: string[]; confidence: number };
    }> {
      try {
        return await cloud.suggestFixV2(run_id, { test_name });
      } catch {
        return {
          run_id,
          test_name,
          suggestion: {
            description: "suggest-fix not yet available on cloud-platform-app",
            code_diff: "",
            affected_files: [],
            confidence: 0,
          },
        };
      }
    },
    async listJourneys(project_id: string, limit = 50): Promise<{ data: UserJourney[]; total: number }> {
      // Best-effort: fetch journeys from the repo-navigation payload.
      const nav = await cloud.getRepoNavigation(project_id).catch(() => ({}) as Record<string, unknown>);
      const edges = Array.isArray((nav as { edges?: unknown }).edges)
        ? ((nav as { edges: Array<Record<string, unknown>> }).edges)
        : [];
      const data: UserJourney[] = edges.slice(0, limit).map((e, idx) => ({
        id: String(e.id ?? `edge-${idx}`),
        project_id,
        name: String(e.name ?? e.from ?? `path-${idx}`),
        events: Array.isArray(e.sequence) ? (e.sequence as string[]) : [],
        user_count: Number(e.users ?? 0),
        session_count: Number(e.sessions ?? 0),
        last_seen: String(e.lastSeen ?? new Date().toISOString()),
      }));
      return { data, total: data.length };
    },
    async getTestMap(project_id: string): Promise<{ data: TestCoverageEntry[] }> {
      // Derive from repo test-impact response.
      const impact = await cloud.getTestImpact(project_id).catch(() => ({} as Record<string, unknown>));
      const tests = Array.isArray((impact as { tests?: unknown }).tests)
        ? ((impact as { tests: Array<Record<string, unknown>> }).tests)
        : [];
      return {
        data: tests.map((t) => ({
          test_id: String(t.testId ?? ""),
          test_name: String(t.title ?? ""),
          suite: String(t.suite ?? ""),
          project_id,
          journey_ids: Array.isArray(t.journeyIds) ? (t.journeyIds as string[]) : [],
          code_node_ids: Array.isArray(t.codeNodeIds) ? (t.codeNodeIds as string[]) : [],
          tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
          source_file: typeof t.filePath === "string" ? (t.filePath as string) : undefined,
        })),
      };
    },
    async getCodeMap(project_id: string): Promise<{ data: CodeNode[] }> {
      try {
        const v2 = await cloud.getCodeMapV2(project_id);
        return {
          data: v2.data.map((n) => ({
            id: n.id,
            file: n.file_path,
            name: n.name,
            kind: (["function", "class", "method", "module"].includes(n.type)
              ? n.type
              : "function") as CodeNode["kind"],
            start_line: 0,
            end_line: 0,
          })),
        };
      } catch {
        // Platform either hasn't deployed /mcp/repos/:id/code-map yet or the
        // repo has no indexed code map. Local mode (`tr_index_repo`) is the
        // fallback — handled by CodeMap.loadLocal in the context engine.
        return { data: [] };
      }
    },
    async getCoverageReport(project_id: string): Promise<CoverageReport> {
      const impact = await cloud.getTestImpact(project_id).catch(() => ({} as Record<string, unknown>));
      return {
        project_id,
        generated_at: new Date().toISOString(),
        user_coverage: Number((impact as { calculation?: { userCoverage?: number } }).calculation?.userCoverage ?? 0),
        test_coverage: Number((impact as { calculation?: { testCoverage?: number } }).calculation?.testCoverage ?? 0),
        total_journeys: 0,
        covered_journeys: 0,
        uncovered_journeys: 0,
        total_code_nodes: 0,
        covered_code_nodes: 0,
        gaps_summary: [],
      };
    },
    async getCoverageGaps(project_id: string, limit = 20): Promise<{ data: CoverageGap[] }> {
      const impact = await cloud.getTestImpact(project_id).catch(() => ({} as Record<string, unknown>));
      const gaps = Array.isArray((impact as { gaps?: unknown }).gaps)
        ? ((impact as { gaps: Array<Record<string, unknown>> }).gaps)
        : [];
      return {
        data: gaps.slice(0, limit).map((g) => ({
          journey_id: String(g.journeyId ?? ""),
          journey_name: String(g.name ?? ""),
          user_count: Number(g.userCount ?? 0),
          session_count: Number(g.sessionCount ?? 0),
          events: Array.isArray(g.events) ? (g.events as string[]) : [],
          pp_coverage_gain: Number(g.coverageGain ?? 0),
        })),
      };
    },
    getRunArtifacts: (runId: string) => cloud.getRunArtifacts(runId),
    async getTestSource(_test_id: string): Promise<{ test_id: string; source: string; file: string }> {
      return { test_id: _test_id, source: "", file: "" };
    },
  };
}

export function legacyAmplitudeAdapter(cloud: CloudOps) {
  return {
    async getUserCount(run_id: string): Promise<AmplitudeUserCount> {
      const res = await cloud.amplitudeEvents({ eventType: "error" }).catch(() => ({ eventType: "error", points: [] as Array<{ date: string; count: number }> }));
      const points = collection<{ date: string; count: number }>(res, "points") ?? [];
      const total = points.reduce((s, p) => s + p.count, 0);
      const peak = points.reduce((a, b) => (a.count > b.count ? a : b), { date: new Date().toISOString(), count: 0 });
      return { run_id, affected_users: total, peak_time: peak.date, error_path: "" };
    },
    async getSessions(run_id: string, limit = 50): Promise<{ run_id: string; sessions: AmplitudeSession[]; total: number }> {
      try {
        const v2 = await cloud.getAmplitudeSessionsV2(run_id, limit);
        return {
          run_id: v2.run_id,
          total: v2.total,
          sessions: v2.sessions.map((s) => ({
            session_id: s.session_id,
            user_id: s.user_id ?? "",
            device_type: "",
            country: "",
            error_event: s.events[0] ?? "",
            occurred_at: s.started_at,
          })),
        };
      } catch {
        return { run_id, sessions: [], total: 0 };
      }
    },
    async listTopJourneys(project_id: string, limit = 50): Promise<{
      project_id: string;
      journeys: Array<{ id: string; name: string; events: string[]; user_count: number; session_count: number; last_seen: string }>;
    }> {
      const nav = await cloud.getRepoNavigation(project_id).catch(() => ({} as Record<string, unknown>));
      const edges = Array.isArray((nav as { edges?: unknown }).edges)
        ? ((nav as { edges: Array<Record<string, unknown>> }).edges)
        : [];
      return {
        project_id,
        journeys: edges.slice(0, limit).map((e, idx) => ({
          id: String(e.id ?? `edge-${idx}`),
          name: String(e.name ?? `path-${idx}`),
          events: Array.isArray(e.sequence) ? (e.sequence as string[]) : [],
          user_count: Number(e.users ?? 0),
          session_count: Number(e.sessions ?? 0),
          last_seen: String(e.lastSeen ?? new Date().toISOString()),
        })),
      };
    },
  };
}

export function legacyLokiAdapter(cloud: CloudOps) {
  return {
    async queryRange(query: string, time_range?: string): Promise<LokiQueryResponse> {
      const now = Date.now();
      const hoursMatch = time_range?.match(/(\d+)h/);
      const hours = hoursMatch ? parseInt(hoursMatch[1]!, 10) : 24;
      const start = new Date(now - hours * 3600 * 1000).toISOString();
      const end = new Date(now).toISOString();
      // No `.catch()` swallow here: a Loki query that did not run must not be
      // reported as a quiet production signal. `wrapUpstreamError` has already
      // turned a real failure into a typed TestRelicMcpError with actionable
      // text ("… 404 Not Found" for an unconnected integration), and the
      // registry renders that as an isError result. `tr_user_impact` degrades
      // on its own with `.catch(() => null)`.
      const r = await cloud.lokiLogs({ query, start, end, limit: 500 });
      const raw = collection<PlatformLokiLog>(r, "lines");
      if (!raw) {
        throw new UpstreamError(
          "Loki query returned a payload with no `lines` array. The platform proxy answered 2xx but not with a log response — " +
            "typically CloudFront rewriting a 403/404 (e.g. the grafana-loki integration is not connected) into 200 + index.html. " +
            "Connect Grafana Loki under Settings → Integrations, or check the response's content-type and X-Cache header.",
          "cloud",
          false,
        );
      }
      const lines = raw.map((l) => ({
        timestamp: l.timestamp,
        level: String(l.labels?.level ?? "info"),
        service: String(l.labels?.service ?? "unknown"),
        message: l.message,
      }));
      const peak = lines.length;
      return {
        query,
        time_range: time_range ?? `${hours}h`,
        error_rate_peak: peak,
        peak_time: lines[0]?.timestamp ?? new Date().toISOString(),
        total_errors: countOr(r, "total", lines.length),
        log_lines: lines,
      };
    },
  };
}

export function legacyJiraAdapter(cloud: CloudOps) {
  return {
    async findIssuesByLabel(label: string): Promise<{ issues: JiraTicket[]; total: number }> {
      const r = await cloud.jiraSearch({ q: label }).catch(() => ({ issues: [], total: 0 }) as PlatformJiraSearch);
      const issues = (collection<PlatformJiraIssue>(r, "issues") ?? []).map(toJiraTicket);
      return { issues, total: countOr(r, "total", issues.length) };
    },
    async createIssue(body: {
      summary: string;
      priority: string;
      labels: string[];
      description?: string;
    }): Promise<JiraTicket> {
      const issue = await cloud.jiraCreateIssue(body);
      return toJiraTicket(issue);
    },
  };
}

export function legacyClickhouseAdapter(cloud: CloudOps) {
  return {
    async queryFlakinessScores(run_id: string): Promise<{ data: FlakinessQueryResult[]; rows: number }> {
      // ClickHouse does not exist on cloud-platform-app; derive approximate flakiness.
      const r = await cloud.getFlakiness(undefined, 7).catch(() => ({ window: 7, scores: [] }));
      const scores = collection<FlakinessRow>(r, "scores") ?? [];
      return {
        data: scores.map((s) => ({
          test_id: s.testId,
          test_name: s.testTitle,
          flakiness_score: toFraction(s.score),
          p90_duration_ms: 0,
          run_count_7d: s.totalRuns,
          failure_count_7d: s.flakyRuns,
        })),
        rows: scores.length,
      };
    },
  };
}
