import { z } from "zod";
import { suggestFix } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const suggestFixInputSchema = z.object({
  run_id: z.string().describe("The test run ID containing the failing test"),
  test_name: z
    .string()
    .describe("The full test name to generate a fix suggestion for, e.g. 'Checkout > Payment > completes purchase with valid card'"),
});

export type SuggestFixInput = z.infer<typeof suggestFixInputSchema>;

export async function suggestTestFix(input: SuggestFixInput): Promise<string> {
  const { run_id, test_name } = input;

  let result;
  try {
    result = await suggestFix(run_id, test_name);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  const { suggestion } = result;

  return [
    `## Fix Suggestion: ${test_name}`,
    ``,
    `**Confidence:** ${(suggestion.confidence * 100).toFixed(0)}%`,
    `**Affected files:** ${suggestion.affected_files.join(", ")}`,
    ``,
    `### Description`,
    ``,
    suggestion.description,
    ``,
    `### Suggested Code Change`,
    ``,
    "```diff",
    suggestion.code_diff,
    "```",
  ].join("\n");
}
