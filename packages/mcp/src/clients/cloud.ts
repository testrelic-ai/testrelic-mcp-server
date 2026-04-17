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

function toRun(r: PlatformRun): TestRun {
  const s = r.summary ?? {};
  return {
    run_id: r.runId,
    project_id: r.repoId,
    framework: r.testFramework ?? "unknown",
    status: (r.status === "completed" ? "passed" : (r.status as TestRun["status"])),
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
      const { project_id, ...rest } = params;
      const page = params.cursor ? parseInt(params.cursor, 10) : 1;
      const q: Record<string, unknown> = { ...rest, page };
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
      const r = await client.get<{ run: PlatformRun }>(`/runs/${encodeURIComponent(runId)}`);
      return toRun(r.run);
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
    getRunTimeline(runId: string): Promise<{ timeline: Array<Record<string, unknown>> }> {
      return client.get(`/runs/${encodeURIComponent(runId)}/timeline`);
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
      return {
        run_id: runId,
        failures: timeline.timeline
          .filter((t) => String(t.status ?? "").toLowerCase() === "failed")
          .map((t) => ({
            test_id: String(t.testId ?? t.id ?? ""),
            test_name: String(t.title ?? t.name ?? ""),
            suite: String(t.suite ?? ""),
            error_type: String((t.error as Record<string, unknown> | undefined)?.type ?? "Error"),
            error_message: String((t.error as Record<string, unknown> | undefined)?.message ?? ""),
            stack_trace: String((t.error as Record<string, unknown> | undefined)?.stack ?? ""),
            duration_ms: Number(t.durationMs ?? 0),
            retry_count: Number(t.retry ?? 0),
            video_url: "",
            video_timestamp_ms: 0,
            screenshot_url: "",
          })),
      };
    },
    async getFlakyTests(p: { project_id?: string; days?: number; threshold?: number }): Promise<{
      data: FlakyTest[];
      total: number;
      days: number;
    }> {
      const res = await cloud.getFlakiness(p.project_id, p.days ?? 7);
      const filtered = res.scores.filter((s) => s.score >= (p.threshold ?? 0));
      return {
        data: filtered.map((s) => ({
          test_id: s.testId,
          test_name: s.testTitle,
          suite: s.suite,
          project_id: s.repoId,
          flakiness_score: s.score,
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
    async dismissFlakyTest(_test_id: string, _reason: string): Promise<{
      success: boolean;
      test_id: string;
      known_flaky: boolean;
    }> {
      // Not yet exposed by cloud-platform-app; surface clean failure.
      return { success: false, test_id: _test_id, known_flaky: false };
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
    async getProjectTrends(_project_id: string): Promise<ProjectTrends> {
      return { project_id: _project_id, period_days: 30, data: [] };
    },
    async getActiveAlerts(): Promise<ActiveAlert[]> {
      return [];
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
      return {
        run_id,
        root_cause: "RCA endpoint not yet available on cloud-platform-app",
        confidence: 0,
        affected_component: "",
        suggested_fix: "",
        evidence: [],
        generated_at: new Date().toISOString(),
      };
    },
    async suggestFix(run_id: string, test_name: string): Promise<{
      run_id: string;
      test_name: string;
      suggestion: { description: string; code_diff: string; affected_files: string[]; confidence: number };
    }> {
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
    async getCodeMap(_project_id: string): Promise<{ data: CodeNode[] }> {
      // cloud-platform-app does not yet expose a remote code map.
      // Local mode is handled by CodeMap.loadLocal — this stub just returns empty.
      return { data: [] };
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
      const total = res.points.reduce((s, p) => s + p.count, 0);
      const peak = res.points.reduce((a, b) => (a.count > b.count ? a : b), { date: new Date().toISOString(), count: 0 });
      return { run_id, affected_users: total, peak_time: peak.date, error_path: "" };
    },
    async getSessions(run_id: string, limit = 50): Promise<{ run_id: string; sessions: AmplitudeSession[]; total: number }> {
      // Amplitude session export is not exposed by the proxy today.
      const _ = limit; // acknowledged
      return { run_id, sessions: [], total: 0 };
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
      const r = await cloud.lokiLogs({ query, start, end, limit: 500 }).catch(() => ({ lines: [], total: 0 }) as PlatformLokiResponse);
      const lines = r.lines.map((l) => ({
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
        total_errors: r.total,
        log_lines: lines,
      };
    },
  };
}

export function legacyJiraAdapter(cloud: CloudOps) {
  return {
    async findIssuesByLabel(label: string): Promise<{ issues: JiraTicket[]; total: number }> {
      const r = await cloud.jiraSearch({ q: label }).catch(() => ({ issues: [], total: 0 }) as PlatformJiraSearch);
      return { issues: r.issues.map(toJiraTicket), total: r.total };
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
      return {
        data: r.scores.map((s) => ({
          test_id: s.testId,
          test_name: s.testTitle,
          flakiness_score: s.score,
          p90_duration_ms: 0,
          run_count_7d: s.totalRuns,
          failure_count_7d: s.flakyRuns,
        })),
        rows: r.scores.length,
      };
    },
  };
}
