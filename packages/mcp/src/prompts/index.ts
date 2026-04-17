import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Ready-made prompts the client UI can surface as slash commands.
 * Each one guides the agent through a canonical workflow — tools it should
 * call, in what order, and what to do with the results.
 */

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "create_test_from_gap",
    {
      title: "Create a test for the highest-impact coverage gap",
      description:
        "Finds the top uncovered journey, plans a test, generates code, and runs a dry-run type check. End-to-end flow.",
      argsSchema: {
        project_id: z.string().describe("TestRelic project_id"),
        framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional(),
      },
    },
    ({ project_id, framework }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Create a high-impact test for ${project_id}.`,
              `1. Call \`tr_coverage_gaps\` with project_id="${project_id}" limit=3.`,
              `2. Call \`tr_plan_test\` with the highest-gain journey_id from step 1${framework ? ` and framework="${framework}"` : ""}.`,
              `3. Call \`tr_generate_test\` with the plan_cache_key from step 2.`,
              `4. Call \`tr_dry_run_test\` with the generated file_path.`,
              `5. Summarise: what user-coverage gain the new test brings and any dry-run issues.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "triage_and_heal",
    {
      title: "Triage a failing run, correlate impact, propose a heal",
      description: "Diagnose → correlate user impact → propose a healing patch → optionally file a Jira ticket.",
      argsSchema: {
        run_id: z.string(),
      },
    },
    ({ run_id }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Triage run ${run_id}.`,
              `1. Call \`tr_diagnose_run\` with run_id="${run_id}".`,
              `2. Call \`tr_user_impact\` with run_id="${run_id}".`,
              `3. Call \`tr_ai_rca\` with run_id="${run_id}".`,
              `4. Call \`tr_heal_run\` with run_id="${run_id}" — propose a patch.`,
              `5. If user impact is high, call \`tr_create_jira\` with dry_run=true and surface the summary for confirmation.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "pr_impact_gate",
    {
      title: "Risk-rank tests for a PR diff",
      description: "Given a diff, rank tests into MUST/SHOULD/OPTIONAL buckets with a user-impact risk score.",
      argsSchema: {
        project_id: z.string(),
        unified_diff: z.string(),
      },
    },
    ({ project_id, unified_diff }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Gate the following diff for ${project_id}.`,
              `1. Call \`tr_analyze_diff\` with the attached unified_diff.`,
              `2. Call \`tr_select_tests\` with the same inputs.`,
              `3. Summarise: risk level, MUST-run tests, SHOULD-run tests, and which journeys are at risk.`,
              "",
              "Diff:",
              "```diff",
              unified_diff,
              "```",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
