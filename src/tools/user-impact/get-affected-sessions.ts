import { z } from "zod";
import { getSessions } from "../../clients/amplitude.js";
import { formatClientError } from "../../auth/validate.js";

export const getAffectedSessionsInputSchema = z.object({
  run_id: z.string().describe("The test run ID whose failure path to trace in Amplitude"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum number of sessions to return"),
});

export type GetAffectedSessionsInput = z.infer<typeof getAffectedSessionsInputSchema>;

export async function getAffectedSessions(input: GetAffectedSessionsInput): Promise<string> {
  const { run_id, limit } = input;

  let result;
  try {
    result = await getSessions(run_id, limit);
  } catch (err) {
    throw new Error(formatClientError(err, "Amplitude"));
  }

  const { sessions, total } = result;

  if (!sessions.length) {
    return `No Amplitude sessions found for run ${run_id}. This run may not have a corresponding production failure, or Amplitude data may not be available for this time window.`;
  }

  const byDevice = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.device_type] = (acc[s.device_type] ?? 0) + 1;
    return acc;
  }, {});

  const byCountry = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.country] = (acc[s.country] ?? 0) + 1;
    return acc;
  }, {});

  const deviceSummary = Object.entries(byDevice)
    .sort((a, b) => b[1] - a[1])
    .map(([d, c]) => `${d}: ${c}`)
    .join(", ");

  const countrySummary = Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c, n]) => `${c}: ${n}`)
    .join(", ");

  const lines: string[] = [
    `## Affected Amplitude Sessions: ${run_id}`,
    ``,
    `**Total sessions returned:** ${sessions.length} (of ${total} total affected)`,
    `**Device breakdown:** ${deviceSummary}`,
    `**Top countries:** ${countrySummary}`,
    ``,
    `### Session List`,
    ``,
  ];

  for (const s of sessions) {
    lines.push(
      `- \`${s.session_id}\`  User: ${s.user_id}  |  ${s.device_type} / ${s.country}  |  ${s.error_event}  |  ${s.occurred_at}`
    );
  }

  return lines.join("\n");
}
