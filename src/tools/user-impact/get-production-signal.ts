import { z } from "zod";
import { queryRange } from "../../clients/loki.js";
import { formatClientError } from "../../auth/validate.js";

export const getProductionSignalInputSchema = z.object({
  error_pattern: z
    .string()
    .describe(
      "Error pattern or keyword to search for in Loki logs, e.g. 'checkout_payment_failed' or 'TimeoutError'"
    ),
  time_range: z
    .string()
    .optional()
    .describe("ISO time range as 'start/end', e.g. '2026-02-28T13:00:00Z/2026-02-28T15:00:00Z'"),
});

export type GetProductionSignalInput = z.infer<typeof getProductionSignalInputSchema>;

export async function getProductionSignal(input: GetProductionSignalInput): Promise<string> {
  const { error_pattern, time_range } = input;

  let lokiData;
  try {
    lokiData = await queryRange(error_pattern, time_range);
  } catch (err) {
    throw new Error(formatClientError(err, "Grafana Loki"));
  }

  if (!lokiData.log_lines.length) {
    return `No production log lines found matching "${error_pattern}"${time_range ? ` in range ${time_range}` : ""}. The error may not have reached production or the pattern may not match any log events.`;
  }

  const lines: string[] = [
    `## Production Signal: "${error_pattern}"`,
    ``,
    `**Time range:** ${lokiData.time_range}`,
    `**Peak error rate:** ${(lokiData.error_rate_peak * 100).toFixed(1)}% at ${lokiData.peak_time ?? "unknown"}`,
    `**Total errors:** ${lokiData.total_errors.toLocaleString()}`,
    ``,
    `### Log Lines (${lokiData.log_lines.length})`,
    ``,
  ];

  for (const log of lokiData.log_lines) {
    const rateInfo = log.error_rate !== undefined ? ` [error_rate=${(log.error_rate * 100).toFixed(1)}%]` : "";
    lines.push(`\`${log.timestamp}\` **[${log.level}]** \`${log.service}\`${rateInfo}`);
    lines.push(`> ${log.message}`);
    lines.push(``);
  }

  return lines.join("\n");
}
