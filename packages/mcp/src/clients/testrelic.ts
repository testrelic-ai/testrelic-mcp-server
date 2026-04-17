import type {
  ActiveAlert,
  FlakyTest,
  PaginatedResponse,
  ProjectConfig,
  ProjectTrends,
  RunFailuresResponse,
  TestRun,
  UserJourney,
  CoverageReport,
  CoverageGap,
  CodeNode,
  TestCoverageEntry,
} from "../types/index.js";
import type { ServiceClient } from "./http.js";

/**
 * TestRelic API client methods. v2 adds endpoints for journeys, coverage map,
 * code map, and healing that are served by the mock server (and will be added
 * to the real platform API).
 */

export function testrelicOps(client: ServiceClient) {
  return {
    listRuns(params: {
      project_id?: string;
      framework?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    }): Promise<PaginatedResponse<TestRun>> {
      return client.get("/runs", params);
    },
    getRun(run_id: string): Promise<TestRun> {
      return client.get(`/runs/${run_id}`);
    },
    getRunFailures(run_id: string): Promise<RunFailuresResponse> {
      return client.get(`/runs/${run_id}/failures`);
    },
    getFlakyTests(params: { project_id?: string; days?: number; threshold?: number }): Promise<{
      data: FlakyTest[];
      total: number;
      days: number;
    }> {
      return client.get("/flaky-tests", params);
    },
    dismissFlakyTest(test_id: string, reason: string): Promise<{
      success: boolean;
      test_id: string;
      known_flaky: boolean;
    }> {
      return client.patch(`/tests/${test_id}/dismiss-flaky`, { reason });
    },
    getProjectConfig(project_id: string): Promise<ProjectConfig> {
      return client.get(`/projects/${project_id}/config`);
    },
    getProjectTrends(project_id: string): Promise<ProjectTrends> {
      return client.get(`/projects/${project_id}/trends`);
    },
    getActiveAlerts(): Promise<ActiveAlert[]> {
      return client.get("/alerts/active");
    },
    getAiRca(run_id: string): Promise<{
      run_id: string;
      root_cause: string;
      confidence: number;
      affected_component: string;
      suggested_fix: string;
      evidence: string[];
      generated_at: string;
    }> {
      return client.post("/ai-rca", { run_id });
    },
    suggestFix(run_id: string, test_name: string): Promise<{
      run_id: string;
      test_name: string;
      suggestion: {
        description: string;
        code_diff: string;
        affected_files: string[];
        confidence: number;
      };
    }> {
      return client.post("/suggest-fix", { run_id, test_name });
    },
    /** v2: user journeys (Amplitude-derived, persisted on the platform). */
    listJourneys(project_id: string, limit = 50): Promise<{ data: UserJourney[]; total: number }> {
      return client.get("/journeys", { project_id, limit });
    },
    /** v2: test→journey/code-node map. */
    getTestMap(project_id: string): Promise<{ data: TestCoverageEntry[] }> {
      return client.get("/test-map", { project_id });
    },
    /** v2: static code map. */
    getCodeMap(project_id: string): Promise<{ data: CodeNode[] }> {
      return client.get("/code-map", { project_id });
    },
    /** v2: the pre-computed coverage report. */
    getCoverageReport(project_id: string): Promise<CoverageReport> {
      return client.get(`/projects/${project_id}/coverage-report`);
    },
    /** v2: ranked coverage gaps for a project. */
    getCoverageGaps(project_id: string, limit = 20): Promise<{ data: CoverageGap[] }> {
      return client.get(`/projects/${project_id}/coverage-gaps`, { limit });
    },
    /** v2: artefact fetch for replay (video url, trace url, step-level log). */
    getRunArtifacts(run_id: string): Promise<{ run_id: string; artifacts: Array<{ kind: string; url: string; note?: string }> }> {
      return client.get(`/runs/${run_id}/artifacts`);
    },
    /** v2: test source by test_id. */
    getTestSource(test_id: string): Promise<{ test_id: string; source: string; file: string }> {
      return client.get(`/tests/${test_id}/source`);
    },
  };
}

export type TestRelicOps = ReturnType<typeof testrelicOps>;
