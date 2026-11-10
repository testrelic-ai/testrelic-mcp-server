import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";
import { buildTier0Features, classifyFailureWithTier0, predictSelectorSurvival, predictTestImpact } from "./tier0.js";
import { TIER0_S1_MODEL } from "./tier0-model.js";
import { TIER0_S3_MODEL } from "./tier0-s3-model.js";
import { TIER0_S4_MODEL } from "./tier0-s4-model.js";

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

// Ostra Tier 0 S1 — PoC synthetic training data, not yet retrained on real
// TestRelic run data (see ostra-tier0/QUESTIONS.md). `decision` is "defer"
// (not one of the 5 classes) when the model is under its confidence floor —
// deliberately, not an error: it means "don't trust a guess here."
const TIER0_CLASSIFICATION_SHAPE = z.object({
  task: z.string(),
  decision: z.string(),
  value: z.string().nullable(),
  p: z.number(),
  probabilities: z.record(z.string(), z.number()),
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
      project_key: z
        .string()
        .optional()
        .describe("Jira project key. Omit to use the project from the repo's Jira scope or the integration"),
      priority: z.enum(["P1", "P2", "P3", "P4"]).optional().default("P2"),
      dry_run: z.boolean().optional().default(false),
    },
    aliases: [{ name: "testrelic_create_jira_ticket", description: "Create or dedupe a Jira ticket for a run." }],
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const project_key = input.project_key as string | undefined;
      const priority = (input.priority as string | undefined) ?? "P2";
      const dry_run = input.dry_run as boolean | undefined;
      // The platform sends status slugs ("done"), so an exact "Done" match
      // never excluded closed tickets and they were returned as duplicates.
      const existing = (await ctx.clients.jira.findIssuesByLabel(run_id)).issues.filter(
        (t) => !/^(done|closed|resolved)$/i.test(String(t.status ?? "")),
      );
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
      // `suite` is "" (not undefined) when the platform has no spec file, so `??`
      // left a double space in the summary and an empty Jira label.
      const where = topFailure?.suite || topFailure?.test_name || "unknown";
      const summary = `[TestRelic] ${where} ${topFailure?.error_type ?? "failures"} — ${run_id}`;
      const descParts = [
        `*Automatically created by TestRelic MCP Server.*`,
        "",
        `*Run:* ${run_id} | *Branch:* ${run.branch} @ ${run.commit_sha}`,
        `*Failures:* ${failuresData.failures.length} / ${run.total}`,
        `*Time:* ${run.started_at}`,
      ];
      if (userImpact && userImpact.affected_users > 0) {
        descParts.push(
          `*Amplitude error events (run dates):* ${userImpact.affected_users.toLocaleString()}` +
            (userImpact.error_path ? ` at ${userImpact.error_path}` : ""),
        );
      }
      if (rcaData) descParts.push("", `*Root cause (${(rcaData.confidence * 100).toFixed(0)}%):* ${rcaData.root_cause}`, `*Suggested fix:* ${rcaData.suggested_fix}`);
      if (topFailure) {
        descParts.push("", `*Primary failure:* ${topFailure.test_name}`, `{code}${topFailure.stack_trace}{code}`);
      }
      const description = descParts.join("\n");
      const labels = ["testrelic", run_id, ...(topFailure?.suite ? [topFailure.suite] : [])];
      if (dry_run) {
        return {
          text: ["## Dry run — ticket preview", "", `**Summary:** ${summary}`, `**Priority:** ${priority}`, `**Labels:** ${labels.join(", ")}`, "", "**Description:**", description].join("\n"),
          structured: { dry_run: true, summary, priority, labels, description, project_key },
        };
      }
      const ticket = await ctx.clients.jira.createIssue({ summary, priority, labels, description, project_key });
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
    name: "tr_classify_failure",
    capability: "triage",
    title: "Classify a failure with Ostra Tier 0",
    description:
      "Offline, no-network classification of why ONE test failed — flaky, product_bug, test_bug, environment, or selector_drift — with a calibrated confidence. Use when the user wants a fast first read on a single failure before reaching for tr_diagnose_run's full platform RCA or tr_ai_rca's sampled analysis: 'is this flaky or real', 'classify this failure', 'what kind of failure is this'. Honestly returns decision: \"defer\" (value: null) instead of guessing when under its confidence floor — a defer is a correct, useful answer, not a failed call; route to tr_diagnose_run or tr_ai_rca for those. PoC model trained on synthetic data (see testrelic-mcp-server's integration notes in ostra-tier0/QUESTIONS.md) — treat a confident call as a strong first read, not a verdict.",
    inputSchema: {
      run_id: z.string(),
      test_id: z.string(),
    },
    // Nullable: an unknown test_id is a legitimate answer (mirrors
    // tr_diagnose_run's RUN_SHAPE.nullable() for an unknown run_id), not an
    // error — every branch below emits the same `classification`/`features` keys.
    // `features` echoes the exact input vector the model scored — AUG-14's
    // Studio review card persists it alongside a confirmed/corrected label so
    // a future retrain has a real feature vector to train from, not just the
    // final label (see ostra-tier0/QUESTIONS.md).
    outputSchema: {
      classification: TIER0_CLASSIFICATION_SHAPE.nullable(),
      features: z.record(z.string(), z.number()).nullable(),
      // Echoes the input test_id, and the test_name resolved from the run
      // (null when there's no failure to resolve it from) — so a caller
      // doesn't need a second round trip just to get the human-readable
      // name, and so a Studio-style review card can label itself without
      // re-deriving identity from the request it already sent.
      test_id: z.string(),
      test_name: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const test_id = input.test_id as string;
      const [failuresData, flakinessData] = await Promise.all([
        ctx.clients.testrelic.getRunFailures(run_id).catch(() => ({ run_id, failures: [] })),
        ctx.clients.clickhouse.queryFlakinessScores(run_id).catch(() => ({ data: [], rows: 0 })),
      ]);
      const failure = failuresData.failures.find((f) => f.test_id === test_id);
      if (!failure) {
        return {
          text: `No failure found for test_id "${test_id}" in run ${run_id} — nothing to classify.`,
          structured: { classification: null, features: null, test_id, test_name: null },
        };
      }
      const flakiness = flakinessData.data.find((f) => f.test_id === test_id);
      // Diff/DOM evidence (AUG-11's full capture-adapter shape) isn't available
      // from run/test ids alone — those features stay missing in tier0.ts,
      // never guessed at 0.
      const evidence = {
        errorMessage: failure.error_message,
        flakeRate50: flakiness?.flakiness_score,
        runs50: flakiness?.run_count_7d,
        failedCount50: flakiness?.failure_count_7d,
      };
      const classification = classifyFailureWithTier0(TIER0_S1_MODEL, evidence);
      const features = buildTier0Features(evidence);
      const text =
        classification.decision === "defer"
          ? `## Tier 0 — ${failure.test_name}\n\nNot confident enough to call this one (best guess ${(classification.p * 100).toFixed(0)}% — below the defer threshold). Try tr_diagnose_run or tr_ai_rca for a fuller read.`
          : `## Tier 0 — ${failure.test_name}\n\n**${classification.value}** at ${(classification.p * 100).toFixed(0)}% confidence.`;
      return { text, structured: { classification, features, test_id, test_name: failure.test_name } };
    },
  },
  {
    name: "tr_predict_selector_survival",
    capability: "triage",
    title: "Predict whether a locator survives the next release (Ostra Tier 0 S3)",
    description:
      "Offline, no-network prediction of whether a locator will still resolve after the next release — survives or breaks, with a calibrated confidence. Pass the locator's strategy, whether it currently resolves against the live DOM, and its per-release resolve-rate history (oldest first); this evidence isn't derivable from a run/test id alone, unlike tr_classify_failure, so it rides in as input. Honestly returns decision: \"defer\" (value: null) instead of guessing when under its confidence floor. PoC model trained on synthetic data, class-weighted for a deliberately rare `breaks` class (see ostra-tier0/QUESTIONS.md finding #3) — treat a confident call as a strong first read, not a verdict.",
    inputSchema: {
      locator_id: z.string().optional().describe("Caller's own identifier for this locator, echoed back for correlation"),
      strategy: z.enum(["css", "xpath", "test_id", "text", "role", "none"]).optional(),
      dom_locator_found: z.boolean().optional().describe("Does this locator currently resolve against the live DOM?"),
      history: z
        .array(z.object({ release: z.string(), resolve_rate: z.number().min(0).max(1).optional() }))
        .optional()
        .describe("Per-release resolve rate, oldest first"),
    },
    outputSchema: {
      classification: TIER0_CLASSIFICATION_SHAPE,
      locator_id: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const locator_id = (input.locator_id as string | undefined) ?? null;
      const history = (input.history as Array<{ release: string; resolve_rate?: number }> | undefined)?.map((h) => ({
        release: h.release,
        resolveRate: h.resolve_rate,
      }));
      const classification = predictSelectorSurvival(TIER0_S3_MODEL, {
        strategy: input.strategy as "css" | "xpath" | "test_id" | "text" | "role" | "none" | undefined,
        domLocatorFound: input.dom_locator_found as boolean | undefined,
        history,
      });
      const text =
        classification.decision === "defer"
          ? `## Tier 0 selector survival${locator_id ? ` — ${locator_id}` : ""}\n\nNot confident enough to call this one (best guess ${(classification.p * 100).toFixed(0)}% — below the defer threshold).`
          : `## Tier 0 selector survival${locator_id ? ` — ${locator_id}` : ""}\n\n**${classification.value}** at ${(classification.p * 100).toFixed(0)}% confidence.`;
      return { text, structured: { classification, locator_id } };
    },
  },
  {
    name: "tr_predict_test_impact",
    capability: "triage",
    title: "Predict whether a diff impacts a candidate test (Ostra Tier 0 S4)",
    description:
      "Offline, no-network prediction of whether a diff impacts one candidate test — impacted or not_impacted, with a calibrated confidence. Pass the diff's shape (files/lines changed, whether it touches test/selector files) and the candidate's historical co-change rate with those files plus its historical fail rate; this evidence isn't derivable from a run id alone, so it rides in as input. Different mechanism from tr_select_tests/tr_analyze_diff (coverage-map + Amplitude journey risk scoring) — this is a trained classifier over the Ostra Tier 0 capture-adapter shape, additive alongside those, not a replacement. Honestly returns decision: \"defer\" (value: null) instead of guessing when under its confidence floor. PoC model trained on synthetic data, class-weighted for a deliberately rare `impacted` class (see ostra-tier0/QUESTIONS.md finding #3).",
    inputSchema: {
      diff_files_changed: z.number().optional(),
      diff_lines_added: z.number().optional(),
      diff_lines_removed: z.number().optional(),
      diff_touches_test_file: z.boolean().optional(),
      diff_touches_selector_file: z.boolean().optional(),
      test_id: z.string(),
      co_change_rate: z.number().min(0).max(1).optional().describe("How often this test's file changes alongside the diff's files, historically"),
      historical_fail_rate: z.number().min(0).max(1).optional().describe("How often this test fails on diffs shaped like this one, historically"),
    },
    outputSchema: {
      classification: TIER0_CLASSIFICATION_SHAPE,
      test_id: z.string(),
    },
    handler: async (input, _ctx) => {
      const test_id = input.test_id as string;
      const classification = predictTestImpact(TIER0_S4_MODEL, {
        diffFilesChanged: input.diff_files_changed as number | undefined,
        diffLinesAdded: input.diff_lines_added as number | undefined,
        diffLinesRemoved: input.diff_lines_removed as number | undefined,
        diffTouchesTestFile: input.diff_touches_test_file as boolean | undefined,
        diffTouchesSelectorFile: input.diff_touches_selector_file as boolean | undefined,
        coChangeRate: input.co_change_rate as number | undefined,
        historicalFailRate: input.historical_fail_rate as number | undefined,
      });
      const text =
        classification.decision === "defer"
          ? `## Tier 0 test impact — ${test_id}\n\nNot confident enough to call this one (best guess ${(classification.p * 100).toFixed(0)}% — below the defer threshold).`
          : `## Tier 0 test impact — ${test_id}\n\n**${classification.value}** at ${(classification.p * 100).toFixed(0)}% confidence.`;
      return { text, structured: { classification, test_id } };
    },
  },
  // `tr_list_runs` was removed in 3.3.0. It was a self-declared identical
  // duplicate of `tr_recent_runs` (same inputSchema, same
  // clients.testrelic.listRuns call) and cost three registered names — itself,
  // its alias, and the tool it duplicated. `tr_recent_runs` (capability: core)
  // renders a strict superset: pass-rate and duration in addition to counts.
  // Callers on the v1 name get it back via TESTRELIC_MCP_LEGACY_ALIASES=1.
];
