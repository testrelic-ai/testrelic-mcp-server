import { z } from "zod";
import { getFlakyTests } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const flakyTestsInputSchema = z.object({
  project_id: z.string().optional().describe("Filter by project ID, e.g. PROJ-1"),
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .default(7)
    .describe("Lookback window in days"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.3)
    .describe(
      "Minimum flakiness score to include (0.0–1.0). Default 0.3 = tests that fail 30%+ of the time."
    ),
});

export type FlakyTestsInput = z.infer<typeof flakyTestsInputSchema>;

export async function getFlakyTestsForProject(input: FlakyTestsInput): Promise<string> {
  let result;
  try {
    result = await getFlakyTests(input);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  const { data: tests, total } = result;

  if (!tests.length) {
    return `No flaky tests found with a flakiness score above ${input.threshold ?? 0.3} in the last ${input.days ?? 7} days.`;
  }

  const lines: string[] = [
    `## Flaky Tests (${total} above threshold ${input.threshold ?? 0.3}, last ${input.days ?? 7} days)`,
    ``,
  ];

  for (const t of tests) {
    const scoreBar = "█".repeat(Math.round(t.flakiness_score * 10)) + "░".repeat(10 - Math.round(t.flakiness_score * 10));
    const knownTag = t.known_flaky ? ` [known flaky: ${t.known_flaky_reason}]` : "";
    lines.push(`**${t.test_name}**${knownTag}`);
    lines.push(
      `  Score: ${(t.flakiness_score * 100).toFixed(0)}% ${scoreBar}  ` +
        `| Failures: ${t.failure_count}/${t.failure_count + t.pass_count}  ` +
        `| Suite: ${t.suite}  |  ID: ${t.test_id}`
    );
    lines.push(`  Last seen: ${t.last_seen}`);
    lines.push(``);
  }

  lines.push(
    `To suppress noise from known-flaky tests, call \`testrelic_dismiss_flaky\` with the test_id and a reason.`
  );

  return lines.join("\n");
}
