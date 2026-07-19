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

  server.registerPrompt(
    "connect_marketplace_app",
    {
      title: "Connect a marketplace app end-to-end",
      description:
        "Fetch a marketplace app, surface its config fields, validate credentials, and connect (OAuth or direct).",
      argsSchema: {
        slug: z.string().describe("Marketplace app slug, e.g. \"jira\""),
        auth_method: z.string().optional().describe("Override auth method hint (e.g. \"api_key\", \"oauth\")."),
      },
    },
    ({ slug, auth_method }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Connect marketplace app "${slug}".`,
              `1. Call \`tr_marketplace_get_app\` with slug="${slug}". Inspect \`requiresOAuth\`, \`authMethod\`${auth_method ? ` (caller hinted "${auth_method}")` : ""}, and \`configFields\`.`,
              `2. Display the \`configFields\` to the user (label + helperText for each) so they know what credentials to provide. Mask any \`secret: true\` fields in the echo back.`,
              `3. Call \`tr_marketplace_validate\` with slug="${slug}" and the gathered credentials. If \`ok === false\`, surface the error and stop.`,
              `4. If \`requiresOAuth\` is true, call \`tr_marketplace_start_oauth\` with slug="${slug}" and direct the user to the returned \`redirectUrl\`.`,
              `5. Otherwise, call \`tr_marketplace_connect\` with slug="${slug}" and the validated credentials.`,
              `6. Summarise: connection status, connection id, and any next steps the user must complete.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "ask_ai_with_context",
    {
      title: "Ask the platform AI with repo and run context",
      description:
        "Gather contextual signals (repo description, run diagnosis) and feed them into a single tr_ask_ai call.",
      argsSchema: {
        question: z.string().describe("The user's question to ask the platform AI."),
        repo_id: z.string().optional().describe("Optional TestRelic repo_id to attach as context."),
        run_id: z.string().optional().describe("Optional run_id to diagnose and attach as context."),
      },
    },
    ({ question, repo_id, run_id }) => {
      const steps: string[] = [`Answer the following question with full platform context: "${question}".`];
      let n = 1;
      if (repo_id) {
        steps.push(`${n}. Call \`tr_describe_repo\` with repo_id="${repo_id}" to summarise the repo's current state (runs, coverage, integrations).`);
        n += 1;
      }
      if (run_id) {
        steps.push(`${n}. Call \`tr_diagnose_run\` with run_id="${run_id}" to gather failure signals.`);
        n += 1;
      }
      steps.push(
        `${n}. Call \`tr_ask_ai\` with a consolidated message that combines the user's question with the context gathered above${repo_id || run_id ? " (summarise, do not paste raw payloads)" : ""}.`,
      );
      n += 1;
      steps.push(`${n}. Surface the AI response and any returned artifacts to the user.`);
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: steps.join("\n") },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "generate_executive_report",
    {
      title: "Generate an executive PDF report for a repo",
      description:
        "Pull recent runs and coverage, generate a report artifact, then export it as a downloadable PDF.",
      argsSchema: {
        repo_id: z.string().describe("TestRelic repo_id the report is about."),
        days: z.string().optional().describe("Lookback window in days for recent runs (default 7)."),
      },
    },
    ({ repo_id, days }) => {
      const window = days ?? "7";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Produce an executive report for repo ${repo_id} covering the last ${window} days.`,
                `1. Call \`tr_recent_runs\` with project_id="${repo_id}" days=${window} to gather run history.`,
                `2. Call \`tr_coverage_report\` with project_id="${repo_id}" to capture the current coverage posture.`,
                `3. Call \`tr_generate_report\` with the consolidated inputs from steps 1 and 2 to produce a report artifact. Capture the returned \`artifact_id\`.`,
                `4. Call \`tr_artifacts_export\` with the artifact_id and format="pdf" to obtain a downloadable URL.`,
                `5. Summarise headline metrics (pass rate, user/test coverage, top gaps) and surface the PDF URL to the user.`,
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "session_to_jira",
    {
      title: "Turn a failing run into a Jira ticket via a session workspace",
      description:
        "Diagnose the run, render a shareable session workspace artifact, and file a Jira ticket that links to it.",
      argsSchema: {
        run_id: z.string().describe("The failing run_id to triage and ticket."),
      },
    },
    ({ run_id }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `File a Jira ticket for failing run ${run_id} with a linked session workspace.`,
              `1. Call \`tr_diagnose_run\` with run_id="${run_id}" to collect failure signals and user impact.`,
              `2. Call \`tr_render_session_workspace\` with run_id="${run_id}" to produce a shareable artifact. Capture its URL or artifact_id.`,
              `3. Call \`tr_create_jira\` with a clear summary, the diagnose findings in the description, and the session workspace link appended at the end of the description.`,
              `4. Surface the Jira issue key and URL alongside the session workspace link to the user.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
