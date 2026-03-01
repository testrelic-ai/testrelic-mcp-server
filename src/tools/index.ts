import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { diagnosisInputSchema, diagnoseFailure } from "./analytics/diagnose-failure.js";
import { listRunsInputSchema, listTestRuns } from "./analytics/list-runs.js";
import { flakyTestsInputSchema, getFlakyTestsForProject } from "./analytics/get-flaky-tests.js";
import { compareRunsInputSchema, compareRuns } from "./analytics/compare-runs.js";
import { searchFailuresInputSchema, searchFailures } from "./analytics/search-failures.js";

import { correlateUserImpactInputSchema, correlateUserImpact } from "./user-impact/correlate-user-impact.js";
import { getProductionSignalInputSchema, getProductionSignal } from "./user-impact/get-production-signal.js";
import { getAffectedSessionsInputSchema, getAffectedSessions } from "./user-impact/get-affected-sessions.js";

import { getAiRcaInputSchema, fetchAiRca } from "./actions/get-ai-rca.js";
import { createJiraTicketInputSchema, createJiraTicket } from "./actions/create-jira-ticket.js";
import { suggestFixInputSchema, suggestTestFix } from "./actions/suggest-fix.js";
import { dismissFlakyInputSchema, dismissFlakyTest } from "./actions/dismiss-flaky.js";

export function registerTools(server: McpServer): void {
  // ─── Group 1: Test Analytics ──────────────────────────────────────────────

  server.tool(
    "testrelic_diagnose_failure",
    "Full failure analysis for a test run: errors, stack traces, flakiness scores, and video markers. Internally fetches and combines all data sources.",
    diagnosisInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await diagnoseFailure(input) }],
    })
  );

  server.tool(
    "testrelic_list_runs",
    "Paginated list of test runs with pass/fail summary. Always returns a next_cursor for pagination.",
    listRunsInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await listTestRuns(input) }],
    })
  );

  server.tool(
    "testrelic_get_flaky_tests",
    "Returns tests ranked by flakiness score above a threshold. Shows failure frequency, score, and known-flaky status.",
    flakyTestsInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await getFlakyTestsForProject(input) }],
    })
  );

  server.tool(
    "testrelic_compare_runs",
    "Diffs two test runs — what regressed, what improved, and what remains broken in both.",
    compareRunsInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await compareRuns(input) }],
    })
  );

  server.tool(
    "testrelic_search_failures",
    "Full-text search across test names, error messages, and stack traces across recent failed runs.",
    searchFailuresInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await searchFailures(input) }],
    })
  );

  // ─── Group 2: User Impact Correlation ────────────────────────────────────

  server.tool(
    "testrelic_correlate_user_impact",
    "Links test failure → Amplitude user count + Loki error rate in production. Returns real user blast radius and log spike correlated to the test failure window.",
    correlateUserImpactInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await correlateUserImpact(input) }],
    })
  );

  server.tool(
    "testrelic_get_production_signal",
    "Pulls live Grafana Loki logs filtered by error pattern matching a test failure. Returns error rates, peak times, and raw log lines.",
    getProductionSignalInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await getProductionSignal(input) }],
    })
  );

  server.tool(
    "testrelic_get_affected_sessions",
    "Returns Amplitude session IDs and metadata for users who hit the same failure path as the test run.",
    getAffectedSessionsInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await getAffectedSessions(input) }],
    })
  );

  // ─── Group 3: AI Root Cause & Actions ────────────────────────────────────

  server.tool(
    "testrelic_get_ai_rca",
    "Fetches AI root cause analysis for a test failure: root cause summary, confidence score, supporting evidence, and suggested code fix.",
    getAiRcaInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await fetchAiRca(input) }],
    })
  );

  server.tool(
    "testrelic_create_jira_ticket",
    "Creates a pre-filled Jira issue with RCA, stack trace, and user impact count. Deduplicates first — returns existing ticket if one already exists for this run.",
    createJiraTicketInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await createJiraTicket(input) }],
    })
  );

  server.tool(
    "testrelic_suggest_fix",
    "Returns a code-level fix suggestion for a failing test, including a unified diff and affected files.",
    suggestFixInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await suggestTestFix(input) }],
    })
  );

  server.tool(
    "testrelic_dismiss_flaky",
    "Marks a test as known flaky to suppress noise and alerts. Records the reason so the team understands why it was suppressed.",
    dismissFlakyInputSchema.shape,
    async (input) => ({
      content: [{ type: "text", text: await dismissFlakyTest(input) }],
    })
  );
}
