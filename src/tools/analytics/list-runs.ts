import { z } from "zod";
import { listRuns } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const listRunsInputSchema = z.object({
  project_id: z.string().optional().describe("Filter by project ID, e.g. PROJ-1"),
  framework: z
    .enum(["playwright", "cypress", "jest", "vitest"])
    .optional()
    .describe("Filter by test framework"),
  status: z
    .enum(["passed", "failed", "running", "cancelled"])
    .optional()
    .describe("Filter by run status"),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor — pass the next_cursor value from a previous response"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Number of results to return (max 20)"),
});

export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

export async function listTestRuns(input: ListRunsInput): Promise<string> {
  let result;
  try {
    result = await listRuns(input);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  const { data: runs, next_cursor, total } = result;

  if (!runs.length) {
    return "No test runs found matching your filters.";
  }

  const lines: string[] = [
    `## Test Runs (${runs.length} of ${total} total)`,
    ``,
  ];

  for (const run of runs) {
    const passRate = run.total > 0 ? ((run.passed / run.total) * 100).toFixed(1) : "0.0";
    const duration = (run.duration_ms / 1000).toFixed(1);
    const status = run.status === "passed" ? "✓ passed" : `✗ ${run.status}`;
    lines.push(
      `- **${run.run_id}** [${status}]  ${run.failed} failed · ${run.flaky} flaky · ${passRate}% pass  |  ${run.framework}  |  ${run.branch}@${run.commit_sha}  |  ${duration}s  |  ${run.started_at}`
    );
  }

  lines.push(``);
  if (next_cursor) {
    lines.push(`**Next page cursor:** \`${next_cursor}\`  (pass as \`cursor\` to get the next page)`);
  } else {
    lines.push(`_No more pages._`);
  }

  return lines.join("\n");
}
