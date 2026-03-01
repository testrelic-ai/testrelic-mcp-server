import { z } from "zod";
import { dismissFlakyTest as dismissFlakyTestClient } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const dismissFlakyInputSchema = z.object({
  test_id: z.string().describe("The test ID to mark as known flaky, e.g. TEST-checkout-001"),
  reason: z
    .string()
    .min(10)
    .describe(
      "Reason for dismissing — be specific so the team understands why the noise is suppressed, e.g. 'External SMTP provider has variable delivery latency in staging'"
    ),
});

export type DismissFlakyInput = z.infer<typeof dismissFlakyInputSchema>;

export async function dismissFlakyTest(input: DismissFlakyInput): Promise<string> {
  const { test_id, reason } = input;

  let result;
  try {
    result = await dismissFlakyTestClient(test_id, reason);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  if (!result.success) {
    return `Failed to mark ${test_id} as known flaky. The test may not exist or the update was rejected.`;
  }

  return [
    `## Test Dismissed as Known Flaky`,
    ``,
    `**Test ID:** ${result.test_id}`,
    `**Status:** Known flaky — alerts and failure noise from this test will be suppressed`,
    `**Reason recorded:** ${reason}`,
    ``,
    `This test will continue to run in CI but will not trigger alerts or block PRs until the known-flaky flag is cleared.`,
    `To re-enable alerting, remove the known-flaky label from the test in the TestRelic dashboard.`,
  ].join("\n");
}
