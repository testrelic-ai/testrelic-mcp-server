/**
 * Shared platform types. Kept intentionally close to the v1 shape so the
 * mock-server fixtures continue to work unchanged.
 */

export type RunStatus = "passed" | "failed" | "running" | "cancelled";

export interface TestRun {
  run_id: string;
  project_id: string;
  framework: string;
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  branch: string;
  commit_sha: string;
  triggered_by: string;
}

export interface TestRunSummary {
  run_id: string;
  project_id: string;
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  started_at: string;
}

export interface TestFailure {
  test_id: string;
  test_name: string;
  suite: string;
  error_type: string;
  error_message: string;
  stack_trace: string;
  duration_ms: number;
  retry_count: number;
  video_url: string;
  video_timestamp_ms: number;
  screenshot_url: string;
}

export interface RunFailuresResponse {
  run_id: string;
  failures: TestFailure[];
}

export interface FlakyTest {
  test_id: string;
  test_name: string;
  suite: string;
  project_id: string;
  flakiness_score: number;
  failure_count: number;
  pass_count: number;
  last_seen: string;
  first_seen: string;
  known_flaky: boolean;
  known_flaky_reason?: string;
}

export interface AmplitudeUserCount {
  run_id: string;
  affected_users: number;
  peak_time: string;
  error_path: string;
}

export interface AmplitudeSession {
  session_id: string;
  user_id: string;
  device_type: string;
  country: string;
  error_event: string;
  occurred_at: string;
}

export interface LokiLogLine {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  error_rate?: number;
}

export interface LokiQueryResponse {
  query: string;
  time_range: string;
  error_rate_peak: number;
  peak_time: string;
  total_errors: number;
  log_lines: LokiLogLine[];
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  url: string;
  labels: string[];
  created_at: string;
}

export interface FlakinessQueryResult {
  test_id: string;
  test_name: string;
  flakiness_score: number;
  p90_duration_ms: number;
  run_count_7d: number;
  failure_count_7d: number;
}

export interface ProjectConfig {
  project_id: string;
  project_name: string;
  frameworks: string[];
  integrations: {
    amplitude: boolean;
    loki: boolean;
    jira: boolean;
    clickhouse: boolean;
  };
  created_at: string;
  default_branch: string;
  alert_threshold_flakiness: number;
}

export interface TrendPoint {
  date: string;
  pass_rate: number;
  total_runs: number;
  avg_duration_ms: number;
  flaky_count: number;
}

export interface ProjectTrends {
  project_id: string;
  period_days: number;
  data: TrendPoint[];
}

export interface ActiveAlert {
  alert_id: string;
  project_id: string;
  type: "flakiness_spike" | "pass_rate_drop" | "duration_regression" | "error_rate_spike";
  severity: "critical" | "warning" | "info";
  message: string;
  triggered_at: string;
  run_id?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
  total: number;
}

/** ─── v2-only types ───────────────────────────────────────────────────── */

export interface UserJourney {
  id: string;
  project_id: string;
  name: string;
  /** Ordered event signature. */
  events: string[];
  /** Distinct users observed on this path in the last 30 days. */
  user_count: number;
  /** Sessions in the last 30 days. */
  session_count: number;
  /** Critical property names used to disambiguate similar event chains. */
  critical_props?: string[];
  sample_session_ids?: string[];
  last_seen: string;
}

export interface TestCoverageEntry {
  test_id: string;
  test_name: string;
  suite: string;
  project_id: string;
  /** Ordered list of journey IDs this test exercises. */
  journey_ids: string[];
  /** Code node identifiers (e.g. `src/checkout/api.ts:pay()`). */
  code_node_ids: string[];
  /** Static tag annotations, e.g. `@journey:checkout-guest`. */
  tags?: string[];
  /** Source file containing the test. */
  source_file?: string;
}

export interface CoverageReport {
  project_id: string;
  generated_at: string;
  user_coverage: number;
  test_coverage: number;
  total_journeys: number;
  covered_journeys: number;
  uncovered_journeys: number;
  total_code_nodes: number;
  covered_code_nodes: number;
  gaps_summary: Array<{ journey_id: string; user_count: number; reason: string }>;
}

export interface CoverageGap {
  journey_id: string;
  journey_name: string;
  user_count: number;
  session_count: number;
  events: string[];
  /** Percentage points of user coverage we'd gain by covering this journey. */
  pp_coverage_gain: number;
  /** Existing tests partially overlapping this journey, by overlap ratio. */
  partial_overlaps?: Array<{ test_id: string; overlap: number }>;
}

export interface CodeNode {
  id: string;
  file: string;
  name: string;
  kind: "function" | "class" | "method" | "module";
  start_line: number;
  end_line: number;
  /** Free-form semantic tags (route path, handler name, etc.). */
  tags?: string[];
  /** Referenced by these tests (test_id list). */
  covered_by?: string[];
}

export interface DiffAnalysis {
  changed_files: string[];
  affected_nodes: CodeNode[];
  touched_tests: Array<{ test_id: string; reason: string }>;
  touched_journeys: Array<{ journey_id: string; user_count: number }>;
  risk_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
}

export interface TestSelection {
  must: string[];
  should: string[];
  optional: string[];
  reasoning: Record<string, string>;
}

export interface TestPlan {
  journey_id?: string;
  goal: string;
  framework: "playwright" | "cypress" | "jest" | "vitest";
  steps: Array<{ step: number; action: string; expectation: string }>;
  data_requirements?: string[];
  preconditions?: string[];
}

export interface GeneratedTest {
  framework: string;
  file_path: string;
  code: string;
  plan: TestPlan;
  cache_key: string;
}

export interface HealingPatch {
  run_id: string;
  test_id: string;
  reason: string;
  unified_diff: string;
  affected_files: string[];
  confidence: number;
}
