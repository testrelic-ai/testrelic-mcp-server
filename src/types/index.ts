// ─── Test Run ─────────────────────────────────────────────────────────────────

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

// ─── Test Failure ─────────────────────────────────────────────────────────────

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

// ─── Flaky Test ───────────────────────────────────────────────────────────────

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

// ─── Amplitude ────────────────────────────────────────────────────────────────

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

// ─── Loki ─────────────────────────────────────────────────────────────────────

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

// ─── Jira ─────────────────────────────────────────────────────────────────────

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  url: string;
  labels: string[];
  created_at: string;
}

// ─── ClickHouse / Flakiness ───────────────────────────────────────────────────

export interface FlakinessQueryResult {
  test_id: string;
  test_name: string;
  flakiness_score: number;
  p90_duration_ms: number;
  run_count_7d: number;
  failure_count_7d: number;
}

// ─── Project ──────────────────────────────────────────────────────────────────

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

// ─── Trends ───────────────────────────────────────────────────────────────────

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

// ─── Alert ────────────────────────────────────────────────────────────────────

export interface ActiveAlert {
  alert_id: string;
  project_id: string;
  type: "flakiness_spike" | "pass_rate_drop" | "duration_regression" | "error_rate_spike";
  severity: "critical" | "warning" | "info";
  message: string;
  triggered_at: string;
  run_id?: string;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
  total: number;
}
