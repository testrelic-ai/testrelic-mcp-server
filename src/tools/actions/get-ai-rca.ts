import { z } from "zod";
import { getAiRca } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const getAiRcaInputSchema = z.object({
  run_id: z.string().describe("The test run ID to fetch root cause analysis for"),
});

export type GetAiRcaInput = z.infer<typeof getAiRcaInputSchema>;

export async function fetchAiRca(input: GetAiRcaInput): Promise<string> {
  const { run_id } = input;

  let rca;
  try {
    rca = await getAiRca(run_id);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic AI RCA"));
  }

  const confidencePct = (rca.confidence * 100).toFixed(0);
  const confidenceBar =
    "█".repeat(Math.round(rca.confidence * 10)) +
    "░".repeat(10 - Math.round(rca.confidence * 10));

  const lines: string[] = [
    `## AI Root Cause Analysis: ${run_id}`,
    ``,
    `**Confidence:** ${confidencePct}% ${confidenceBar}`,
    `**Affected component:** ${rca.affected_component}`,
    `**Analysis generated:** ${rca.generated_at}`,
    ``,
    `### Root Cause`,
    ``,
    rca.root_cause,
    ``,
    `### Supporting Evidence`,
    ``,
  ];

  for (const e of rca.evidence) {
    lines.push(`- ${e}`);
  }

  lines.push(``);
  lines.push(`### Suggested Fix`);
  lines.push(``);
  lines.push(rca.suggested_fix);
  lines.push(``);
  lines.push(
    `To create a Jira ticket with this RCA, call \`testrelic_create_jira_ticket\` with run_id="${run_id}".`
  );

  return lines.join("\n");
}
