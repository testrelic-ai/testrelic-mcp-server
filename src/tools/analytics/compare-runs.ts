import { z } from "zod";
import { getRun, getRunFailures } from "../../clients/testrelic.js";
import { formatClientError } from "../../auth/validate.js";

export const compareRunsInputSchema = z.object({
  run_id_a: z.string().describe("The first run ID (usually the newer run)"),
  run_id_b: z.string().describe("The second run ID (usually the baseline/older run)"),
});

export type CompareRunsInput = z.infer<typeof compareRunsInputSchema>;

export async function compareRuns(input: CompareRunsInput): Promise<string> {
  const { run_id_a, run_id_b } = input;

  let runA, runB, failuresA, failuresB;
  try {
    [runA, runB, failuresA, failuresB] = await Promise.all([
      getRun(run_id_a),
      getRun(run_id_b),
      getRunFailures(run_id_a),
      getRunFailures(run_id_b),
    ]);
  } catch (err) {
    throw new Error(formatClientError(err, "TestRelic"));
  }

  const failingInA = new Set(failuresA.failures.map((f) => f.test_id));
  const failingInB = new Set(failuresB.failures.map((f) => f.test_id));

  const regressions = failuresA.failures.filter((f) => !failingInB.has(f.test_id));
  const fixes = failuresB.failures.filter((f) => !failingInA.has(f.test_id));
  const persistent = failuresA.failures.filter((f) => failingInB.has(f.test_id));

  const passRateA = runA.total > 0 ? ((runA.passed / runA.total) * 100).toFixed(1) : "0.0";
  const passRateB = runB.total > 0 ? ((runB.passed / runB.total) * 100).toFixed(1) : "0.0";

  const lines: string[] = [
    `## Run Comparison: ${run_id_a} vs ${run_id_b}`,
    ``,
    `|  | ${run_id_a} | ${run_id_b} |`,
    `|---|---|---|`,
    `| Status | ${runA.status} | ${runB.status} |`,
    `| Pass rate | ${passRateA}% | ${passRateB}% |`,
    `| Failed | ${runA.failed} | ${runB.failed} |`,
    `| Flaky | ${runA.flaky} | ${runB.flaky} |`,
    `| Duration | ${(runA.duration_ms / 1000).toFixed(1)}s | ${(runB.duration_ms / 1000).toFixed(1)}s |`,
    `| Branch | ${runA.branch}@${runA.commit_sha} | ${runB.branch}@${runB.commit_sha} |`,
    ``,
  ];

  if (regressions.length) {
    lines.push(`### Regressions — new failures in ${run_id_a} (${regressions.length})`);
    for (const f of regressions) {
      lines.push(`- **${f.test_name}** — ${f.error_type}: ${f.error_message}`);
    }
    lines.push(``);
  } else {
    lines.push(`### Regressions\n_None — no new test failures introduced._\n`);
  }

  if (fixes.length) {
    lines.push(`### Fixed — failures from ${run_id_b} no longer present (${fixes.length})`);
    for (const f of fixes) {
      lines.push(`- ~~${f.test_name}~~`);
    }
    lines.push(``);
  } else {
    lines.push(`### Fixed\n_None._\n`);
  }

  if (persistent.length) {
    lines.push(`### Persistent failures in both runs (${persistent.length})`);
    for (const f of persistent) {
      lines.push(`- **${f.test_name}** — ${f.error_type}`);
    }
    lines.push(``);
  }

  const verdict =
    regressions.length === 0 && fixes.length > 0
      ? `**Verdict:** ${run_id_a} is an improvement over ${run_id_b}.`
      : regressions.length > 0 && fixes.length === 0
        ? `**Verdict:** ${run_id_a} is a regression — ${regressions.length} new failure(s) introduced.`
        : regressions.length > 0
          ? `**Verdict:** Mixed — ${regressions.length} new regression(s) and ${fixes.length} fix(es).`
          : `**Verdict:** No change in failures between the two runs.`;

  lines.push(verdict);

  return lines.join("\n");
}
