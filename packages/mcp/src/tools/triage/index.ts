import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";

/**
 * Triage capability — migration of the v1 tool set, plus one new entry
 * (tr_search_failures → v1 search-failures). Every v2 tool registers an
 * alias under its old flat name so existing integrations keep working.
 */

export const triageTools: ToolDefinition[] = [
  {
    name: "tr_diagnose_run",
    capability: "triage",
    title: "Diagnose a failing run",
    description:
      "Pulls run metadata, all failures, and ClickHouse flakiness scores; returns a compact diagnostic with video markers (when include_video is true).",
    inputSchema: {
      run_id: z.string(),
      include_video: z.boolean().optional().default(false),
    },
    aliases: [{ name: "testrelic_diagnose_failure", description: "Diagnose a failing run." }],
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const include_video = input.include_video as boolean | undefined;
      const [run, failureData, flakinessData] = await Promise.all([
        ctx.clients.testrelic.getRun(run_id),
        ctx.clients.testrelic.getRunFailures(run_id),
        ctx.clients.clickhouse.queryFlakinessScores(run_id).catch(() => ({ data: [], rows: 0 })),
      ]);
      if (run.status === "passed") {
        return { text: `Run ${run_id} passed all ${run.total} tests in ${(run.duration_ms / 1000).toFixed(1)}s.`, structured: { run } };
      }
      const flakinessMap = new Map(flakinessData.data.map((f) => [f.test_id, f]));
      const { failures } = failureData;
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
    description: "Ranks flaky tests above a threshold over a lookback window.",
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
        const scoreBar = "█".repeat(Math.round(t.flakiness_score * 10)) + "░".repeat(10 - Math.round(t.flakiness_score * 10));
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
      const [runA, runB, failuresA, failuresB] = await Promise.all([
        ctx.clients.testrelic.getRun(input.run_id_a as string),
        ctx.clients.testrelic.getRun(input.run_id_b as string),
        ctx.clients.testrelic.getRunFailures(input.run_id_a as string),
        ctx.clients.testrelic.getRunFailures(input.run_id_b as string),
      ]);
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
  {
    name: "tr_list_runs",
    capability: "triage",
    title: "List recent runs (legacy alias of tr_recent_runs)",
    description: "Alias retained for v1 compatibility; behaviour identical to tr_recent_runs under the core capability.",
    inputSchema: {
      project_id: z.string().optional(),
      framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional(),
      status: z.enum(["passed", "failed", "running", "cancelled"]).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional().default(5),
    },
    aliases: [{ name: "testrelic_list_runs", description: "List recent runs." }],
    deprecated: true,
    handler: async (input, ctx) => {
      const result = await ctx.clients.testrelic.listRuns(input);
      const { data: runs, next_cursor, total } = result;
      if (!runs.length) return { text: "No test runs found.", structured: { runs: [] } };
      const lines = [`## Test Runs (${runs.length} of ${total})`, ""];
      for (const run of runs) {
        lines.push(`- **${run.run_id}** [${run.status}] — ${run.failed} failed · ${run.flaky} flaky — ${run.branch}@${run.commit_sha}`);
      }
      return { text: lines.join("\n"), structured: { runs, next_cursor, total } };
    },
  },
];

export function registerTriageTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of triageTools) register(t);
}
