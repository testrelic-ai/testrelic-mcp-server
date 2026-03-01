import { z } from "zod";
import { getRun, getRunFailures, getAiRca } from "../../clients/testrelic.js";
import { getUserCount } from "../../clients/amplitude.js";
import { findIssuesByLabel, createIssue } from "../../clients/jira.js";
import { formatClientError } from "../../auth/validate.js";

export const createJiraTicketInputSchema = z.object({
  run_id: z.string().describe("The test run ID to file a Jira ticket for"),
  project_key: z
    .string()
    .optional()
    .default("ENG")
    .describe("Jira project key to create the issue in, e.g. ENG, PLATFORM"),
  priority: z
    .enum(["P1", "P2", "P3", "P4"])
    .optional()
    .default("P2")
    .describe("Issue priority: P1 (critical) → P4 (low)"),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, returns a preview of the ticket that would be created without actually creating it"
    ),
});

export type CreateJiraTicketInput = z.infer<typeof createJiraTicketInputSchema>;

export async function createJiraTicket(input: CreateJiraTicketInput): Promise<string> {
  const { run_id, project_key, priority, dry_run } = input;

  // 1. Deduplication check — look for existing open ticket with this run_id label
  let existingTickets;
  try {
    const result = await findIssuesByLabel(run_id);
    existingTickets = result.issues.filter((t) => t.status !== "Done");
  } catch (err) {
    throw new Error(formatClientError(err, "Jira"));
  }

  if (existingTickets.length > 0) {
    const t = existingTickets[0];
    return (
      `A Jira ticket already exists for run ${run_id}: **${t.key}** — "${t.summary}"\n` +
      `Status: ${t.status} | Priority: ${t.priority}\n` +
      `URL: ${t.url}\n\n` +
      `No new ticket was created to avoid duplicates. Update ${t.key} if the issue has changed.`
    );
  }

  // 2. Gather data to populate the ticket
  let run, failuresData, rcaData, userImpact;

  try {
    [run, failuresData] = await Promise.all([getRun(run_id), getRunFailures(run_id)]);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  // RCA and user impact are best-effort — ticket still created if they fail
  try {
    rcaData = await getAiRca(run_id);
  } catch {
    rcaData = null;
  }

  try {
    userImpact = await getUserCount(run_id);
  } catch {
    userImpact = null;
  }

  const failureCount = failuresData.failures.length;
  const topFailure = failuresData.failures[0];
  const summary =
    `[TestRelic] ${topFailure?.suite ?? "unknown"} ${topFailure?.error_type ?? "failures"} — ${run_id}`;

  const descriptionParts: string[] = [
    `*Automatically created by TestRelic MCP Server.*`,
    ``,
    `*Run:* ${run_id}  |  *Branch:* ${run.branch} @ ${run.commit_sha}`,
    `*Failures:* ${failureCount} / ${run.total} tests failed`,
    `*Time:* ${run.started_at}`,
  ];

  if (userImpact) {
    descriptionParts.push(`*Users impacted:* ${userImpact.affected_users.toLocaleString()} at ${userImpact.error_path}`);
  }

  if (rcaData) {
    descriptionParts.push(``, `*Root cause (${(rcaData.confidence * 100).toFixed(0)}% confidence):* ${rcaData.root_cause}`);
    descriptionParts.push(`*Suggested fix:* ${rcaData.suggested_fix}`);
  }

  if (topFailure) {
    descriptionParts.push(
      ``,
      `*Primary failure:* ${topFailure.test_name}`,
      `{code}${topFailure.stack_trace}{code}`
    );
    if (topFailure.video_url) {
      descriptionParts.push(`*Video:* ${topFailure.video_url} (at ${(topFailure.video_timestamp_ms / 1000).toFixed(1)}s)`);
    }
  }

  const description = descriptionParts.join("\n");
  const labels = ["testrelic", run_id, topFailure?.suite ?? "unknown"];

  if (dry_run) {
    return [
      `## Dry Run — Ticket Preview (not created)`,
      ``,
      `**Summary:** ${summary}`,
      `**Priority:** ${priority}`,
      `**Project:** ${project_key}`,
      `**Labels:** ${labels.join(", ")}`,
      ``,
      `**Description:**`,
      description,
    ].join("\n");
  }

  // 3. Create the ticket
  let ticket;
  try {
    ticket = await createIssue({ summary, priority: priority ?? "P2", labels, description });
  } catch (err) {
    throw new Error(formatClientError(err, "Jira"));
  }

  return [
    `## Jira Ticket Created: ${ticket.key}`,
    ``,
    `**Summary:** ${ticket.summary}`,
    `**Status:** ${ticket.status}`,
    `**Priority:** ${ticket.priority}`,
    `**URL:** ${ticket.url}`,
    `**Labels:** ${ticket.labels.join(", ")}`,
    ``,
    userImpact
      ? `**Users impacted:** ${userImpact.affected_users.toLocaleString()}`
      : `_User impact data not available._`,
    rcaData
      ? `**RCA confidence:** ${(rcaData.confidence * 100).toFixed(0)}%`
      : `_RCA not available._`,
  ].join("\n");
}
