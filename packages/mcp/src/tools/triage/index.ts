import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";
import { RUN_FILTER_FRAMEWORKS } from "../frameworks.js";

/**
 * Triage capability — migration of the v1 tool set, plus one new entry
 * (tr_search_failures → v1 search-failures). Every v2 tool registers an
 * alias under its old flat name so existing integrations keep working.
 */

/**
 * Declared output shapes.
 *
 * These describe what THIS PROCESS emits, not what the platform sends — the
 * clients project upstream rows onto our own types first. That is the whole
 * safety property: every field below is produced by a mapper we control
 * (`toRun`, `toFailure`, `queryFlakinessScores`), each of which now defaults
 * rather than forwards, so a drifted upstream degrades a VALUE and can never
 * fail the schema.
 *
 * Why that matters: `validateToolOutput` rejects the entire result on a
 * mismatch, and the registry's guard turns it into an OUTPUT_SCHEMA_VIOLATION
 * error — the caller loses the diagnosis text along with everything else. A
 * schema whose fields depend on an upstream we do not control would convert a
 * degraded answer into no answer at all, which is the failure mode
 * (TEAI-375 / TEAI-397) these schemas exist to prevent.
 */
const RUN_SHAPE = z.object({
  run_id: z.string(),
  project_id: z.string(),
  framework: z.string(),
  status: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  flaky: z.number(),
  duration_ms: z.number(),
  started_at: z.string(),
  finished_at: z.string(),
  branch: z.string(),
  commit_sha: z.string(),
  triggered_by: z.string(),
});

const FAILURE_SHAPE = z.object({
  test_id: z.string(),
  test_name: z.string(),
  suite: z.string(),
  error_type: z.string(),
  error_message: z.string(),
  stack_trace: z.string(),
  duration_ms: z.number(),
  retry_count: z.number(),
  video_url: z.string(),
  video_timestamp_ms: z.number(),
  screenshot_url: z.string(),
});

const FLAKINESS_SHAPE = z.object({
  test_id: z.string(),
  test_name: z.string(),
  flakiness_score: z.number(),
  p90_duration_ms: z.number(),
  run_count_7d: z.number(),
  failure_count_7d: z.number(),
});

export const triageTools: ToolDefinition[] = [
  {
    name: "tr_diagnose_run",
    capability: "triage",
    title: "Diagnose a failing test run",
    description:
      "Drill into one TEST RUN — pulls run metadata, every failing test, error messages, stack traces, and flakiness scores. Use this when the user says 'why did this test run fail', 'what failed in run X', 'tell me about the failures', 'investigate this build', 'show me errors for run …'. Set include_video to also surface video timestamp markers for each failure.",
    inputSchema: {
      run_id: z.string(),
      include_video: z.boolean().optional().default(false),
    },
    // `run` is nullable (an unknown run id is a legitimate answer, not an
    // error), and both arrays are always present — see the branch normalisation
    // in the handler. Declaring this is only safe BECAUSE every branch emits the
    // same three keys; a schema over branchy output is how a tool goes dark.
    outputSchema: {
      run: RUN_SHAPE.nullable(),
      failures: z.array(FAILURE_SHAPE),
      flakiness: z.array(FLAKINESS_SHAPE),
    },
    aliases: [{ name: "testrelic_diagnose_failure", description: "Diagnose a failing run." }],
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const include_video = input.include_video as boolean | undefined;
      const [run, failureData, flakinessData] = await Promise.all([
        // Tolerate a missing/unknown run: getRun throws on not-found rather than
        // null-derefing inside toRun. Surface a clean message instead of a 500.
        ctx.clients.testrelic.getRun(run_id).catch(() => null),
        ctx.clients.testrelic.getRunFailures(run_id).catch(() => ({ run_id, failures: [] })),
        ctx.clients.clickhouse.queryFlakinessScores(run_id).catch(() => ({ data: [], rows: 0 })),
      ]);
      // Every exit below emits the SAME three keys. They used to differ — the
      // not-found branch omitted `flakiness` and the all-passed branch omitted
      // both arrays — which is invisible without an outputSchema and an instant
      // outage with one.
      if (!run) {
        return { text: `Run ${run_id} not found.`, structured: { run: null, failures: [], flakiness: [] } };
      }
      if (run.status === "passed") {
        return {
          text: `Run ${run_id} passed all ${run.total} tests in ${(run.duration_ms / 1000).toFixed(1)}s.`,
          structured: { run, failures: [], flakiness: [] },
        };
      }
      const flakinessMap = new Map(flakinessData.data.map((f) => [f.test_id, f]));
      const failures = failureData?.failures ?? [];
      const lines: string[] = [
        `## Failure Diagnosis: ${run_id}`,
        "",
        `**Run summary:** ${run.failed} failed / ${run.flaky} flaky / ${run.passed} passed (${run.total} total)`,
        `**Branch:** ${run.branch}  |  **Commit:** ${run.commit_sha}`,
        `**Started:** ${run.started_at}  |  **Duration:** ${(run.duration_ms / 1000).toFixed(1)}s`,
        "",
        `### Failures (${failures.length})`,
        "",
      ];
      for (const f of failures) {
        const flakiness = flakinessMap.get(f.test_id);
        lines.push(`#### ${f.test_name}`);
        lines.push(`- **Error type:** ${f.error_type}`);
        lines.push(`- **Message:** ${f.error_message}`);
        if (flakiness) {
          lines.push(
            `- **Flakiness:** ${(flakiness.flakiness_score * 100).toFixed(0)}% (${flakiness.failure_count_7d}/${flakiness.run_count_7d} in 7d)`,
          );
        }
        if (f.retry_count > 0) lines.push(`- **Retried:** ${f.retry_count}x`);
        if (include_video && f.video_url) lines.push(`- **Video:** ${f.video_url} @ ${(f.video_timestamp_ms / 1000).toFixed(1)}s`);
        lines.push("");
      }
      return { text: lines.join("\n"), structured: { run, failures, flakiness: flakinessData.data } };
    },
  },
  {
    name: "tr_flaky_audit",
    capability: "triage",
    title: "Flaky-test audit",
    description:
      "Lists flaky tests in this org — tests whose pass/fail status changes between retries. Use when the user says 'show me flaky tests', 'which tests are unstable', 'why are these tests intermittent', 'flakiness report'. Ranks by flakiness score over a lookback window; pair with tr_dismiss_flaky to mark a test as known-flaky.",
    inputSchema: {
      project_id: z.string().optional(),
      days: z.number().int().min(1).max(90).optional().default(7),
      threshold: z.number().min(0).max(1).optional().default(0.3),
    },
    aliases: [{ name: "testrelic_get_flaky_tests", description: "Ranks flaky tests." }],
    handler: async (input, ctx) => {
      const result = await ctx.clients.testrelic.getFlakyTests({
        project_id: input.project_id as string | undefined,
        days: input.days as number | undefined,
        threshold: input.threshold as number | undefined,
      });
      if (!result.data.length) return { text: `No flaky tests above threshold.`, structured: { tests: [], total: 0 } };
      const lines = [`## Flaky Tests (${result.total} above threshold, last ${input.days ?? 7} days)`, ""];
      for (const t of result.data) {
        // Clamp defensively: the client normalizes scores to 0–1, but a bad
        // value here must degrade the bar, never throw the whole tool
        // (`"░".repeat(negative)` is a hard error).
        const filled = Math.min(10, Math.max(0, Math.round(t.flakiness_score * 10)));
        const scoreBar = "█".repeat(filled) + "░".repeat(10 - filled);
        lines.push(`- **${t.test_name}**${t.known_flaky ? ` [known: ${t.known_flaky_reason}]` : ""}`);
        lines.push(`  ${(t.flakiness_score * 100).toFixed(0)}% ${scoreBar} | ${t.failure_count}/${t.failure_count + t.pass_count} | ${t.suite} | ${t.test_id}`);
      }
      return { text: lines.join("\n"), structured: { tests: result.data, total: result.total } };
    },
  },
  {
    name: "tr_compare_runs",
    capability: "triage",
    title: "Compare two runs",
    description: "Diffs two runs for regressions, fixes, and persistent failures.",
    inputSchema: {
      run_id_a: z.string(),
      run_id_b: z.string(),
    },
    aliases: [{ name: "testrelic_compare_runs", description: "Diff two runs." }],
    handler: async (input, ctx) => {
      const run_id_a = input.run_id_a as string;
      const run_id_b = input.run_id_b as string;
      const [runA, runB, failuresA, failuresB] = await Promise.all([
        // getRun throws on a missing/unknown run; tolerate it so a bad id yields a
        // clean message instead of an INTERNAL tool error (mirrors tr_diagnose_run).
        ctx.clients.testrelic.getRun(run_id_a).catch(() => null),
        ctx.clients.testrelic.getRun(run_id_b).catch(() => null),
        ctx.clients.testrelic.getRunFailures(run_id_a).catch(() => ({ run_id: run_id_a, failures: [] })),
        ctx.clients.testrelic.getRunFailures(run_id_b).catch(() => ({ run_id: run_id_b, failures: [] })),
      ]);
      if (!runA || !runB) {
        const missing = [!runA ? run_id_a : null, !runB ? run_id_b : null].filter(Boolean).join(", ");
        return { text: `Cannot compare — run(s) not found: ${missing}.`, structured: { regressions: [], fixes: [], persistent: [] } };
      }
      const failingInA = new Set(failuresA.failures.map((f) => f.test_id));
      const failingInB = new Set(failuresB.failures.map((f) => f.test_id));
      const regressions = failuresA.failures.filter((f) => !failingInB.has(f.test_id));
      const fixes = failuresB.failures.filter((f) => !failingInA.has(f.test_id));
      const persistent = failuresA.failures.filter((f) => failingInB.has(f.test_id));
      const text = [
        `## Compare ${input.run_id_a} vs ${input.run_id_b}`,
        "",
        `| | ${input.run_id_a} | ${input.run_id_b} |`,
        `|---|---|---|`,
        `| status | ${runA.status} | ${runB.status} |`,
        `| failed | ${runA.failed} | ${runB.failed} |`,
        `| flaky | ${runA.flaky} | ${runB.flaky} |`,
        "",
        `**Regressions:** ${regressions.length} · **Fixes:** ${fixes.length} · **Persistent:** ${persistent.length}`,
      ].join("\n");
      return { text, structured: { regressions, fixes, persistent } };
    },
  },
  {
    name: "tr_search_failures",
    capability: "triage",
    title: "Search failures by text",
    description: "Searches recent failed runs for text matches across test names, error messages, and stack traces.",
    inputSchema: {
      query: z.string(),
      project_id: z.string().optional(),
      date_range: z.string().optional(),
    },
    aliases: [{ name: "testrelic_search_failures", description: "Search recent failures by text." }],
    handler: async (input, ctx) => {
      const allRuns = (await ctx.clients.testrelic.listRuns({ project_id: input.project_id as string | undefined, status: "failed", limit: 20 })).data;
      let filtered = allRuns;
      if (input.date_range) {
        const [from, to] = (input.date_range as string).split("/");
        filtered = allRuns.filter((r) => {
          const d = r.started_at.split("T")[0];
          return from && to && d !== undefined && d >= from && d <= to;
        });
      }
      const q = (input.query as string).toLowerCase();
      const matches: Array<{ run_id: string; test_name: string; error_type: string; error_message: string; occurred_at: string }> = [];
      for (const run of filtered) {
        try {
          const failures = (await ctx.clients.testrelic.getRunFailures(run.run_id)).failures;
          for (const f of failures) {
            const hay = [f.test_name, f.error_message, f.stack_trace, f.error_type].join(" ").toLowerCase();
            if (hay.includes(q)) matches.push({ run_id: run.run_id, test_name: f.test_name, error_type: f.error_type, error_message: f.error_message, occurred_at: run.started_at });
          }
        } catch {
          // skip
        }
      }
      if (!matches.length) return { text: `No failures matching "${input.query}"`, structured: { matches: [] } };
      const lines = [`## Search Results for "${input.query}" (${matches.length})`, ""];
      for (const m of matches) lines.push(`- **[${m.run_id}]** ${m.test_name}\n  ${m.error_type}: ${m.error_message}\n  _${m.occurred_at}_`);
      return { text: lines.join("\n"), structured: { matches } };
    },
  },
  {
    name: "tr_ai_rca",
    capability: "triage",
    title: "AI root cause analysis",
    description: "Fetches the platform-generated RCA for a run (falls back to sampling when the platform has none).",
    inputSchema: { run_id: z.string() },
    aliases: [{ name: "testrelic_get_ai_rca", description: "Fetch AI RCA for a run." }],
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      try {
        const rca = await ctx.clients.testrelic.getAiRca(run_id);
        const text = [
          `## AI RCA — ${run_id}`,
          `**Confidence:** ${(rca.confidence * 100).toFixed(0)}%`,
          `**Affected component:** ${rca.affected_component}`,
          "",
          `### Root cause`,
          rca.root_cause,
          "",
          `### Evidence`,
          ...rca.evidence.map((e) => `- ${e}`),
          "",
          `### Suggested fix`,
          rca.suggested_fix,
        ].join("\n");
        return { text, structured: { rca } };
      } catch (err) {
        // Platform RCA unavailable — try sampling with the failure context.
        const failures = (await ctx.clients.testrelic.getRunFailures(run_id)).failures;
        if (!failures.length) throw err;
        const prompt = [
          `Propose a root cause and fix for these test failures.`,
          ...failures.slice(0, 3).map((f) => `- ${f.test_name}: ${f.error_type} — ${f.error_message}`),
          "",
          `Return 1-2 sentences for root cause and 1-2 sentences for suggested fix.`,
        ].join("\n");
        const sampled = await ctx.sampling.createMessage(prompt, { maxTokens: 300, temperature: 0.2 });
        return {
          text: [`## AI RCA — ${run_id} (sampled fallback)`, "", sampled.text || "RCA not available."].join("\n"),
          structured: { sampled: true, text: sampled.text },
        };
      }
    },
  },
  {
    name: "tr_suggest_fix",
    capability: "triage",
    title: "Platform-suggested fix",
    description: "Returns the TestRelic platform's code-level fix suggestion for a named test in a run.",
    inputSchema: { run_id: z.string(), test_name: z.string() },
    aliases: [{ name: "testrelic_suggest_fix", description: "Platform-suggested code-level fix." }],
    handler: async (input, ctx) => {
      const result = await ctx.clients.testrelic.suggestFix(input.run_id as string, input.test_name as string);
      const { suggestion } = result;
      const text = [
        `## Fix suggestion: ${input.test_name}`,
        `**Confidence:** ${(suggestion.confidence * 100).toFixed(0)}%`,
        `**Affected files:** ${suggestion.affected_files.join(", ")}`,
        "",
        suggestion.description,
        "",
        "```diff",
        suggestion.code_diff,
        "```",
      ].join("\n");
      return { text, structured: result };
    },
  },
  {
    name: "tr_create_jira",
    capability: "triage",
    title: "Create a Jira ticket (with dedupe)",
    description: "Creates or returns an existing Jira ticket for a run. Populates with RCA and user impact when available.",
    inputSchema: {
      run_id: z.string(),
      project_key: z.string().optional().default("ENG"),
      priority: z.enum(["P1", "P2", "P3", "P4"]).optional().default("P2"),
      dry_run: z.boolean().optional().default(false),
    },
    aliases: [{ name: "testrelic_create_jira_ticket", description: "Create or dedupe a Jira ticket for a run." }],
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const project_key = (input.project_key as string | undefined) ?? "ENG";
      const priority = (input.priority as string | undefined) ?? "P2";
      const dry_run = input.dry_run as boolean | undefined;
      const existing = (await ctx.clients.jira.findIssuesByLabel(run_id)).issues.filter((t) => t.status !== "Done");
      if (existing.length > 0) {
        const t = existing[0]!;
        return {
          text: [
            `## Existing Jira ticket — ${t.key}`,
            `**Summary:** ${t.summary}`,
            `**Status:** ${t.status} · **Priority:** ${t.priority}`,
            `**URL:** ${t.url}`,
            "",
            `No new ticket created to avoid duplicates.`,
          ].join("\n"),
          structured: { existing: t, created: false },
        };
      }
      const [run, failuresData] = await Promise.all([
        ctx.clients.testrelic.getRun(run_id),
        ctx.clients.testrelic.getRunFailures(run_id),
      ]);
      const rcaData = await ctx.clients.testrelic.getAiRca(run_id).catch(() => null);
      const userImpact = await ctx.clients.amplitude.getUserCount(run_id).catch(() => null);
      const topFailure = failuresData.failures[0];
      const summary = `[TestRelic] ${topFailure?.suite ?? "unknown"} ${topFailure?.error_type ?? "failures"} — ${run_id}`;
      const descParts = [
        `*Automatically created by TestRelic MCP Server.*`,
        "",
        `*Run:* ${run_id} | *Branch:* ${run.branch} @ ${run.commit_sha}`,
        `*Failures:* ${failuresData.failures.length} / ${run.total}`,
        `*Time:* ${run.started_at}`,
      ];
      if (userImpact) descParts.push(`*Users impacted:* ${userImpact.affected_users.toLocaleString()} at ${userImpact.error_path}`);
      if (rcaData) descParts.push("", `*Root cause (${(rcaData.confidence * 100).toFixed(0)}%):* ${rcaData.root_cause}`, `*Suggested fix:* ${rcaData.suggested_fix}`);
      if (topFailure) {
        descParts.push("", `*Primary failure:* ${topFailure.test_name}`, `{code}${topFailure.stack_trace}{code}`);
      }
      const description = descParts.join("\n");
      const labels = ["testrelic", run_id, topFailure?.suite ?? "unknown"];
      if (dry_run) {
        return {
          text: ["## Dry run — ticket preview", "", `**Summary:** ${summary}`, `**Priority:** ${priority}`, `**Labels:** ${labels.join(", ")}`, "", "**Description:**", description].join("\n"),
          structured: { dry_run: true, summary, priority, labels, description, project_key },
        };
      }
      const ticket = await ctx.clients.jira.createIssue({ summary, priority, labels, description });
      return {
        text: [
          `## Jira created — ${ticket.key}`,
          `**Summary:** ${ticket.summary}`,
          `**Status:** ${ticket.status}`,
          `**Priority:** ${ticket.priority}`,
          `**URL:** ${ticket.url}`,
        ].join("\n"),
        structured: { ticket, created: true },
      };
    },
  },
  {
    name: "tr_dismiss_flaky",
    capability: "triage",
    title: "Dismiss a test as known flaky",
    description: "Marks a test as known-flaky (suppresses alerts) with a required reason.",
    inputSchema: {
      test_id: z.string(),
      reason: z.string().min(10),
    },
    aliases: [{ name: "testrelic_dismiss_flaky", description: "Mark a test as known flaky." }],
    handler: async (input, ctx) => {
      const result = await ctx.clients.testrelic.dismissFlakyTest(input.test_id as string, input.reason as string);
      if (!result.success) return { text: `Failed to mark ${input.test_id} as known flaky.`, structured: { ok: false } };
      const text = [
        `## ${result.test_id} — known flaky`,
        "",
        `**Reason:** ${input.reason}`,
        "",
        `Alerts and failure noise from this test will be suppressed until the flag is cleared in the TestRelic dashboard.`,
      ].join("\n");
      return { text, structured: { ok: true, test_id: result.test_id } };
    },
  },
  // `tr_list_runs` was removed in 3.3.0. It was a self-declared identical
  // duplicate of `tr_recent_runs` (same inputSchema, same
  // clients.testrelic.listRuns call) and cost three registered names — itself,
  // its alias, and the tool it duplicated. `tr_recent_runs` (capability: core)
  // renders a strict superset: pass-rate and duration in addition to counts.
  // Callers on the v1 name get it back via TESTRELIC_MCP_LEGACY_ALIASES=1.
];
