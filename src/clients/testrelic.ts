import axios from "axios";
import type {
  TestRun,
  RunFailuresResponse,
  PaginatedResponse,
} from "../types/index.js";

function base(): string {
  const real = process.env.TESTRELIC_API_BASE_URL;
  const mock = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
  return real ? real : `${mock}/testrelic`;
}

function headers(): Record<string, string> {
  const key = process.env.TESTRELIC_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export async function listRuns(params: {
  project_id?: string;
  framework?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}): Promise<PaginatedResponse<TestRun>> {
  const { data } = await axios.get(`${base()}/runs`, {
    headers: headers(),
    params,
  });
  return data;
}

export async function getRun(run_id: string): Promise<TestRun> {
  const { data } = await axios.get(`${base()}/runs/${run_id}`, {
    headers: headers(),
  });
  return data;
}

export async function getRunFailures(run_id: string): Promise<RunFailuresResponse> {
  const { data } = await axios.get(`${base()}/runs/${run_id}/failures`, {
    headers: headers(),
  });
  return data;
}

export async function getFlakyTests(params: {
  project_id?: string;
  days?: number;
  threshold?: number;
}): Promise<{ data: import("../types/index.js").FlakyTest[]; total: number; days: number }> {
  const { data } = await axios.get(`${base()}/flaky-tests`, {
    headers: headers(),
    params,
  });
  return data;
}

export async function dismissFlakyTest(
  test_id: string,
  reason: string
): Promise<{ success: boolean; test_id: string; known_flaky: boolean }> {
  const { data } = await axios.patch(
    `${base()}/tests/${test_id}/dismiss-flaky`,
    { reason },
    { headers: headers() }
  );
  return data;
}

export async function getProjectConfig(
  project_id: string
): Promise<import("../types/index.js").ProjectConfig> {
  const { data } = await axios.get(`${base()}/projects/${project_id}/config`, {
    headers: headers(),
  });
  return data;
}

export async function getProjectTrends(
  project_id: string
): Promise<import("../types/index.js").ProjectTrends> {
  const { data } = await axios.get(`${base()}/projects/${project_id}/trends`, {
    headers: headers(),
  });
  return data;
}

export async function getActiveAlerts(): Promise<import("../types/index.js").ActiveAlert[]> {
  const { data } = await axios.get(`${base()}/alerts/active`, { headers: headers() });
  return data;
}

export async function getAiRca(run_id: string): Promise<{
  run_id: string;
  root_cause: string;
  confidence: number;
  affected_component: string;
  suggested_fix: string;
  evidence: string[];
  generated_at: string;
}> {
  const { data } = await axios.post(
    `${base()}/ai-rca`,
    { run_id },
    { headers: headers() }
  );
  return data;
}

export async function suggestFix(
  run_id: string,
  test_name: string
): Promise<{
  run_id: string;
  test_name: string;
  suggestion: {
    description: string;
    code_diff: string;
    affected_files: string[];
    confidence: number;
  };
}> {
  const { data } = await axios.post(
    `${base()}/suggest-fix`,
    { run_id, test_name },
    { headers: headers() }
  );
  return data;
}
