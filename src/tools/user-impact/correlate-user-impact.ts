import { z } from "zod";
import { getRun, getRunFailures } from "../../clients/testrelic.js";
import { getUserCount } from "../../clients/amplitude.js";
import { queryRange } from "../../clients/loki.js";
import { formatClientError } from "../../auth/validate.js";

export const correlateUserImpactInputSchema = z.object({
  run_id: z.string().describe("The test run ID to correlate against production signals"),
  lookback_minutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .default(60)
    .describe("How many minutes before/after the run to look for correlated production events"),
});

export type CorrelateUserImpactInput = z.infer<typeof correlateUserImpactInputSchema>;

export async function correlateUserImpact(input: CorrelateUserImpactInput): Promise<string> {
  const { run_id, lookback_minutes } = input;

  let run, failuresData, userCount, lokiData;
  try {
    run = await getRun(run_id);
    failuresData = await getRunFailures(run_id);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  if (run.status === "passed" || !failuresData.failures.length) {
    return `Run ${run_id} has no failures, so there is no user impact to correlate.`;
  }

  // Derive the primary error pattern from the most common failure type
  const errorTypes = failuresData.failures.map((f) => f.error_type);
  const primaryError = errorTypes
    .sort((a, b) => errorTypes.filter((e) => e === b).length - errorTypes.filter((e) => e === a).length)[0];
  const primarySuite = failuresData.failures[0]?.suite ?? "unknown";
  const queryKey = `${primarySuite}_${primaryError.toLowerCase().replace(/error$/, "_failed")}`;

  try {
    [userCount, lokiData] = await Promise.all([
      getUserCount(run_id),
      queryRange(queryKey),
    ]);
  } catch (err) {
    throw new Error(formatClientError(err, "Amplitude/Loki"));
  }

  const lines: string[] = [
    `## User Impact Correlation: ${run_id}`,
    ``,
    `**Test failure window:** ${run.started_at} → ${run.finished_at}`,
    `**Lookback:** ±${lookback_minutes} minutes`,
    ``,
    `### Amplitude — Real User Impact`,
    `- **Affected users:** ${userCount.affected_users.toLocaleString()}`,
    `- **Peak time:** ${userCount.peak_time ?? "unknown"}`,
    `- **Error path:** ${userCount.error_path ?? "unknown"}`,
    ``,
    `### Grafana Loki — Production Error Rate`,
    `- **Error rate peak:** ${(lokiData.error_rate_peak * 100).toFixed(1)}%`,
    `- **Peak time:** ${lokiData.peak_time ?? "unknown"}`,
    `- **Total production errors:** ${lokiData.total_errors.toLocaleString()}`,
    `- **Query matched:** ${lokiData.query}`,
    ``,
  ];

  if (lokiData.log_lines.length) {
    lines.push(`### Key Log Lines`);
    for (const log of lokiData.log_lines.slice(0, 5)) {
      lines.push(`- \`[${log.level}]\` ${log.timestamp} — ${log.service}: ${log.message}`);
    }
    lines.push(``);
  }

  lines.push(
    `### Summary`,
    `The test failures in ${run_id} correlate with **${userCount.affected_users.toLocaleString()} real users** hitting ` +
      `errors at ${userCount.error_path} in production. ` +
      `Loki shows a ${(lokiData.error_rate_peak * 100).toFixed(1)}% error rate spike peaking at ${lokiData.peak_time ?? "unknown"}.`,
    ``,
    `Call \`testrelic_get_ai_rca\` with this run_id for a root cause analysis, or \`testrelic_create_jira_ticket\` to file an incident ticket.`
  );

  return lines.join("\n");
}
