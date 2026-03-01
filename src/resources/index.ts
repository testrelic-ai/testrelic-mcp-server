import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProjectConfig, getProjectTrends, getActiveAlerts, getRun, getRunFailures, getFlakyTests } from "../clients/testrelic.js";
import { formatClientError } from "../auth/validate.js";

/**
 * Registers all 6 TestRelic resources on the MCP server.
 *
 * Resources are nouns — read-only context surfaces the AI can reference
 * without needing to invoke a tool first.
 *
 * URIs follow the testrelic:// scheme defined in the design doc.
 * Template URIs use ResourceTemplate (SDK class) for parameterised paths.
 */
export function registerResources(server: McpServer): void {
  // ─── testrelic://projects/{project_id}/config ─────────────────────────────
  server.resource(
    "project-config",
    new ResourceTemplate("testrelic://projects/{project_id}/config", { list: undefined }),
    { description: "Project settings, registered test frameworks, and active integrations (Amplitude, Loki, Jira, ClickHouse)." },
    async (uri, variables) => {
      const project_id = variables.project_id as string;
      try {
        const config = await getProjectConfig(project_id);
        return { contents: [{ uri: uri.href, text: JSON.stringify(config, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        throw new Error(formatClientError(err, "TestRelic"));
      }
    }
  );

  // ─── testrelic://runs/{run_id}/summary ────────────────────────────────────
  server.resource(
    "run-summary",
    new ResourceTemplate("testrelic://runs/{run_id}/summary", { list: undefined }),
    { description: "Lightweight summary of a test run: counts, duration, status, branch, and commit." },
    async (uri, variables) => {
      const run_id = variables.run_id as string;
      try {
        const run = await getRun(run_id);
        const summary = {
          run_id: run.run_id,
          project_id: run.project_id,
          status: run.status,
          total: run.total,
          passed: run.passed,
          failed: run.failed,
          flaky: run.flaky,
          duration_ms: run.duration_ms,
          started_at: run.started_at,
          branch: run.branch,
          commit_sha: run.commit_sha,
        };
        return { contents: [{ uri: uri.href, text: JSON.stringify(summary, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        throw new Error(formatClientError(err, "TestRelic"));
      }
    }
  );

  // ─── testrelic://runs/{run_id}/full ───────────────────────────────────────
  server.resource(
    "run-full",
    new ResourceTemplate("testrelic://runs/{run_id}/full", { list: undefined }),
    { description: "Complete test run data including all failure details, stack traces, and video markers." },
    async (uri, variables) => {
      const run_id = variables.run_id as string;
      try {
        const [run, failures] = await Promise.all([getRun(run_id), getRunFailures(run_id)]);
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ ...run, failures: failures.failures }, null, 2),
              mimeType: "application/json",
            },
          ],
        };
      } catch (err) {
        throw new Error(formatClientError(err, "TestRelic"));
      }
    }
  );

  // ─── testrelic://projects/{project_id}/flaky-report ───────────────────────
  server.resource(
    "flaky-report",
    new ResourceTemplate("testrelic://projects/{project_id}/flaky-report", { list: undefined }),
    { description: "Current flaky test leaderboard for a project, ranked by flakiness score." },
    async (uri, variables) => {
      const project_id = variables.project_id as string;
      try {
        const result = await getFlakyTests({ project_id, threshold: 0 });
        return { contents: [{ uri: uri.href, text: JSON.stringify(result, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        throw new Error(formatClientError(err, "TestRelic"));
      }
    }
  );

  // ─── testrelic://projects/{project_id}/trends ─────────────────────────────
  server.resource(
    "project-trends",
    new ResourceTemplate("testrelic://projects/{project_id}/trends", { list: undefined }),
    { description: "7-day pass rate, average run duration, test volume, and flaky count trends for a project." },
    async (uri, variables) => {
      const project_id = variables.project_id as string;
      try {
        const trends = await getProjectTrends(project_id);
        return { contents: [{ uri: uri.href, text: JSON.stringify(trends, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        throw new Error(formatClientError(err, "TestRelic"));
      }
    }
  );

  // ─── testrelic://alerts/active ────────────────────────────────────────────
  server.resource(
    "active-alerts",
    "testrelic://alerts/active",
    { description: "Currently firing alerts across all projects — flakiness spikes, pass rate drops, and error rate anomalies." },
    async (uri) => {
      try {
        const alerts = await getActiveAlerts();
        return { contents: [{ uri: uri.href, text: JSON.stringify(alerts, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        throw new Error(formatClientError(err, "TestRelic"));
      }
    }
  );
}
