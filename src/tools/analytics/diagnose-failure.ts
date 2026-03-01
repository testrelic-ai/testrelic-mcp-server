import { z } from "zod";
import { getRunFailures, getRun } from "../../clients/testrelic.js";
import { queryFlakinessScores } from "../../clients/clickhouse.js";
import { formatClientError } from "../../auth/validate.js";

export const diagnosisInputSchema = z.object({
  run_id: z.string().describe("The test run ID to diagnose, e.g. RUN-2847"),
  include_video: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include video URL and timestamp markers in the response"),
});

export type DiagnoseFailureInput = z.infer<typeof diagnosisInputSchema>;

export async function diagnoseFailure(input: DiagnoseFailureInput): Promise<string> {
  const { run_id, include_video } = input;

  let run, failureData, flakinessData;

  try {
    [run, failureData, flakinessData] = await Promise.all([
      getRun(run_id),
      getRunFailures(run_id),
      queryFlakinessScores(run_id),
    ]);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  if (run.status === "passed") {
    return `Run ${run_id} passed all ${run.total} tests in ${(run.duration_ms / 1000).toFixed(1)}s. No failures to diagnose.`;
  }

  const { failures } = failureData;
  if (!failures.length) {
    return `Run ${run_id} has status "${run.status}" but no failure details are available yet. The run may still be processing.`;
  }

  const flakinessMap = new Map(
    flakinessData.data.map((f) => [f.test_id, f])
  );

  const lines: string[] = [
    `## Failure Diagnosis: ${run_id}`,
    ``,
    `**Run summary:** ${run.failed} failed / ${run.flaky} flaky / ${run.passed} passed out of ${run.total} total`,
    `**Branch:** ${run.branch}  |  **Commit:** ${run.commit_sha}`,
    `**Started:** ${run.started_at}  |  **Duration:** ${(run.duration_ms / 1000).toFixed(1)}s`,
    ``,
    `### Failures (${failures.length})`,
    ``,
  ];

  for (const f of failures) {
    const flakiness = flakinessMap.get(f.test_id);
    lines.push(`#### ${f.test_name}`);
    lines.push(`- **Error type:** ${f.error_type}`);
    lines.push(`- **Message:** ${f.error_message}`);
    if (flakiness) {
      lines.push(
        `- **Flakiness score:** ${(flakiness.flakiness_score * 100).toFixed(0)}%  ` +
          `(${flakiness.failure_count_7d}/${flakiness.run_count_7d} runs failed in last 7 days)`
      );
    }
    if (f.retry_count > 0) {
      lines.push(`- **Retried:** ${f.retry_count} time(s) before failing`);
    }
    lines.push(`- **Duration:** ${(f.duration_ms / 1000).toFixed(1)}s`);
    if (include_video && f.video_url) {
      lines.push(`- **Video:** ${f.video_url} (timestamp: ${(f.video_timestamp_ms / 1000).toFixed(1)}s)`);
    }
    lines.push(``);
    lines.push(`  \`\`\``);
    lines.push(`  ${f.stack_trace.split("\n").join("\n  ")}`);
    lines.push(`  \`\`\``);
    lines.push(``);
  }

  const knownFlaky = failures.filter((f) => flakinessMap.has(f.test_id));
  if (knownFlaky.length) {
    lines.push(
      `### Note`,
      `${knownFlaky.length} of the ${failures.length} failures have high flakiness scores and may be infrastructure-related rather than code regressions. ` +
        `Consider calling \`testrelic_get_ai_rca\` with this run_id for a root cause analysis.`
    );
  }

  return lines.join("\n");
}
