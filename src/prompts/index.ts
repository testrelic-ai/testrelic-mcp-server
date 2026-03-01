import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Registers all 5 TestRelic prompts on the MCP server.
 *
 * Prompts are reusable instruction templates with variables.
 * They chain multiple tools behind a single invocation so engineers
 * don't have to describe the same multi-step workflow every time.
 */
export function registerPrompts(server: McpServer): void {
  // ─── testrelic_full_debug ──────────────────────────────────────────────────
  server.prompt(
    "testrelic_full_debug",
    {
      run_id: z.string().describe("The test run ID to fully diagnose"),
      jira_project: z
        .string()
        .optional()
        .describe("Jira project key to create a ticket in (e.g. ENG). Omit to skip ticket creation."),
    },
    ({ run_id, jira_project }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Run a full debug workflow for test run ${run_id}. Execute these steps in order:`,
              ``,
              `1. Call \`testrelic_diagnose_failure\` with run_id="${run_id}" and include_video=true`,
              `   — Get all failure details, stack traces, flakiness scores, and video markers.`,
              ``,
              `2. Call \`testrelic_correlate_user_impact\` with run_id="${run_id}"`,
              `   — Correlate the failures with real user impact (Amplitude sessions + Loki error rate).`,
              ``,
              `3. Call \`testrelic_get_ai_rca\` with run_id="${run_id}"`,
              `   — Fetch the AI root cause analysis with confidence score and suggested fix.`,
              ``,
              jira_project
                ? `4. Call \`testrelic_create_jira_ticket\` with run_id="${run_id}" and project_key="${jira_project}"` +
                  `\n   — Create a Jira ticket. The tool will deduplicate — if a ticket already exists for this run, it returns the existing one.`
                : `4. Summarize your findings without creating a Jira ticket (no jira_project provided).`,
              ``,
              `After completing all steps, synthesize a single response that tells the engineer:`,
              `- What failed and why (root cause + confidence)`,
              `- How many real users were impacted and on what path`,
              `- What to fix (code-level suggestion)`,
              `- The Jira ticket key and URL (or a recommendation to create one)`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  // ─── testrelic_weekly_report ───────────────────────────────────────────────
  server.prompt(
    "testrelic_weekly_report",
    {
      project_id: z.string().describe("The project ID to report on, e.g. PROJ-1"),
      week: z
        .string()
        .optional()
        .describe(
          "ISO week to report on as 'YYYY-MM-DD/YYYY-MM-DD'. Defaults to the last 7 days."
        ),
    },
    ({ project_id, week }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Generate a weekly QA health report for project ${project_id}${week ? ` for the week of ${week}` : " (last 7 days)"}.`,
              ``,
              `Execute these steps in order:`,
              ``,
              `1. Read resource \`testrelic://projects/${project_id}/trends\``,
              `   — Get 7-day pass rate, run volume, duration trends, and flaky count.`,
              ``,
              `2. Call \`testrelic_list_runs\` with project_id="${project_id}" and limit=10`,
              `   — Get the list of recent runs with pass/fail outcomes.`,
              ``,
              `3. Call \`testrelic_get_flaky_tests\` with project_id="${project_id}" and days=7`,
              `   — Get the flaky test leaderboard for the week.`,
              ``,
              `4. Read resource \`testrelic://alerts/active\``,
              `   — Check for any currently firing alerts.`,
              ``,
              `Synthesize a report with these sections:`,
              `- **Weekly Summary** — pass rate trend, total runs, any regressions`,
              `- **Top Failures** — the most common failures and their frequency`,
              `- **Flaky Tests** — the flaky leaderboard with scores`,
              `- **Active Alerts** — any alerts currently firing`,
              `- **Recommendations** — 2–3 actionable next steps for the QA team`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  // ─── testrelic_flaky_audit ────────────────────────────────────────────────
  server.prompt(
    "testrelic_flaky_audit",
    {
      project_id: z.string().describe("The project ID to audit for flaky tests"),
      threshold: z
        .string()
        .optional()
        .describe("Minimum flakiness score to audit (0.0–1.0). Default: 0.3"),
    },
    ({ project_id, threshold }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Perform a flaky test audit for project ${project_id}.`,
              ``,
              `1. Call \`testrelic_get_flaky_tests\` with project_id="${project_id}" and threshold=${threshold ?? "0.3"}`,
              `   — Get all tests above the flakiness threshold.`,
              ``,
              `2. For each test, determine:`,
              `   - Is the flakiness caused by the test itself (test design issue) or infrastructure (timing, network, env)?`,
              `   - Is the score trending up or stable?`,
              `   - Does the test have a known_flaky flag already set?`,
              ``,
              `3. Group the tests into three buckets:`,
              `   - **Fix now** — high score (>0.7), likely code/test design issue, worth fixing`,
              `   - **Suppress** — infrastructure-related, team has accepted the risk, use \`testrelic_dismiss_flaky\` to suppress`,
              `   - **Monitor** — mid-range score (0.3–0.7), not yet clear — flag for review`,
              ``,
              `4. For each "Fix now" test, call \`testrelic_suggest_fix\``,
              `   — Get a code-level fix suggestion.`,
              ``,
              `Return a prioritized action plan: which tests to fix first, which to suppress, and which to watch.`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  // ─── testrelic_regression_review ─────────────────────────────────────────
  server.prompt(
    "testrelic_regression_review",
    {
      run_id: z.string().describe("The current run to review for regressions"),
      baseline_run_id: z.string().describe("The stable baseline run to compare against"),
    },
    ({ run_id, baseline_run_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Review ${run_id} against baseline ${baseline_run_id} for regressions.`,
              ``,
              `1. Call \`testrelic_compare_runs\` with run_id_a="${run_id}" and run_id_b="${baseline_run_id}"`,
              `   — Get a diff of what regressed and what improved.`,
              ``,
              `2. For each regression (new failure not present in the baseline):`,
              `   - Call \`testrelic_get_ai_rca\` with run_id="${run_id}" to understand the root cause`,
              `   - Assess whether it's a real regression or a flaky test`,
              ``,
              `3. Call \`testrelic_correlate_user_impact\` with run_id="${run_id}"`,
              `   — Determine if the regressions are already hitting real users in production.`,
              ``,
              `Return a regression report with:`,
              `- A clear verdict: is this run safe to ship or blocked?`,
              `- For each regression: test name, root cause, user impact, and recommended action`,
              `- A one-line summary suitable for a PR comment or Slack message`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  // ─── testrelic_incident_triage ────────────────────────────────────────────
  server.prompt(
    "testrelic_incident_triage",
    {
      run_id: z.string().describe("The test run ID associated with the P0 incident"),
      slack_channel: z
        .string()
        .optional()
        .describe("Slack channel to draft an update for, e.g. #incidents"),
    },
    ({ run_id, slack_channel }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `P0 incident triage for run ${run_id}. Execute these steps urgently:`,
              ``,
              `1. Call \`testrelic_diagnose_failure\` with run_id="${run_id}" and include_video=true`,
              `   — Immediate failure snapshot.`,
              ``,
              `2. Call \`testrelic_correlate_user_impact\` with run_id="${run_id}" and lookback_minutes=30`,
              `   — Real-time user blast radius.`,
              ``,
              `3. Call \`testrelic_get_ai_rca\` with run_id="${run_id}"`,
              `   — Root cause with confidence score.`,
              ``,
              `4. Call \`testrelic_create_jira_ticket\` with run_id="${run_id}", priority="P1"`,
              `   — File the incident ticket immediately. Deduplication is built in.`,
              ``,
              slack_channel
                ? `5. Draft a Slack incident update for ${slack_channel} with:` +
                  `\n   - One-line description of what broke` +
                  `\n   - User impact count` +
                  `\n   - Assigned Jira ticket key` +
                  `\n   - Estimated time to resolve (based on RCA complexity)` +
                  `\n   - Current status: Investigating | Mitigating | Resolved`
                : `5. Summarize findings for incident handoff (no Slack channel provided).`,
              ``,
              `Speed matters. Keep responses brief and actionable.`,
            ].join("\n"),
          },
        },
      ],
    })
  );
}
