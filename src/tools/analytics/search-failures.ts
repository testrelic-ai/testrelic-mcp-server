import { z } from "zod";
import { listRuns, getRunFailures } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const searchFailuresInputSchema = z.object({
  query: z.string().describe("Text to search for in test names, error messages, and stack traces"),
  project_id: z.string().optional().describe("Limit search to a specific project"),
  date_range: z
    .string()
    .optional()
    .describe(
      "ISO date range as 'YYYY-MM-DD/YYYY-MM-DD', e.g. '2026-02-25/2026-02-28'"
    ),
});

export type SearchFailuresInput = z.infer<typeof searchFailuresInputSchema>;

export async function searchFailures(input: SearchFailuresInput): Promise<string> {
  const { query, project_id, date_range } = input;

  let allRuns;
  try {
    const result = await listRuns({ project_id, status: "failed", limit: 20 });
    allRuns = result.data;
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  // Optional date filter
  let filteredRuns = allRuns;
  if (date_range) {
    const [from, to] = date_range.split("/");
    filteredRuns = allRuns.filter((r) => {
      const d = r.started_at.split("T")[0];
      return d >= from && d <= to;
    });
  }

  const lowerQuery = query.toLowerCase();
  const matches: Array<{ run_id: string; test_name: string; error_type: string; error_message: string; occurred_at: string }> = [];

  for (const run of filteredRuns) {
    let failures;
    try {
      const result = await getRunFailures(run.run_id);
      failures = result.failures;
    } catch {
      continue;
    }

    for (const f of failures) {
      const searchable = [f.test_name, f.error_message, f.stack_trace, f.error_type]
        .join(" ")
        .toLowerCase();
      if (searchable.includes(lowerQuery)) {
        matches.push({
          run_id: run.run_id,
          test_name: f.test_name,
          error_type: f.error_type,
          error_message: f.error_message,
          occurred_at: run.started_at,
        });
      }
    }
  }

  if (!matches.length) {
    return `No failures found matching "${query}"${project_id ? ` in project ${project_id}` : ""}${date_range ? ` between ${date_range}` : ""}.`;
  }

  const lines: string[] = [
    `## Search Results for "${query}" (${matches.length} match${matches.length !== 1 ? "es" : ""})`,
    ``,
  ];

  for (const m of matches) {
    lines.push(`- **[${m.run_id}]** ${m.test_name}`);
    lines.push(`  ${m.error_type}: ${m.error_message}`);
    lines.push(`  _${m.occurred_at}_`);
    lines.push(``);
  }

  return lines.join("\n");
}
