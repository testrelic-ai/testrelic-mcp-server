import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";

/**
 * Coverage capability — the core intelligence behind the ≥95% User-Coverage
 * / ≥95% Test-Coverage goal. Every tool is cache-first and uses the 3-state
 * diff reader for repeat calls on the same project.
 */

export const coverageTools: ToolDefinition[] = [
  {
    name: "tr_user_journeys",
    capability: "coverage",
    title: "Top N Amplitude user journeys",
    description:
      "Returns the top N user journeys for a project ordered by distinct users in the last 30 days. Uses L1+L2 cache with a 1h TTL.",
    inputSchema: {
      project_id: z.string(),
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
    outputSchema: {
      journeys: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          events: z.array(z.string()),
          user_count: z.number(),
          session_count: z.number(),
        }),
      ),
      total_users_tracked: z.number(),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const limit = (input.limit as number | undefined) ?? 20;
      const journeys = await ctx.context.journeys.top(project_id, limit);
      const total = journeys.reduce((s, j) => s + (j.user_count ?? 0), 0);
      if (!journeys.length) {
        return { text: `No journeys available for ${project_id}.`, structured: { journeys: [], total_users_tracked: 0 } };
      }
      const lines = [`## Top ${journeys.length} user journeys — ${project_id}`, "", `**Total users tracked:** ${total.toLocaleString()}`, ""];
      for (const j of journeys) {
        lines.push(`- **\`${j.id}\`** — ${j.name}`);
        lines.push(`  ${j.user_count.toLocaleString()} users · ${j.session_count.toLocaleString()} sessions · ${j.events.length} steps`);
        lines.push(`  ${j.events.join(" → ")}`);
      }
      return {
        text: lines.join("\n"),
        structured: {
          journeys: journeys.map((j) => ({
            id: j.id,
            name: j.name,
            events: j.events,
            user_count: j.user_count,
            session_count: j.session_count,
          })),
          total_users_tracked: total,
        },
      };
    },
  },
  {
    name: "tr_test_map",
    capability: "coverage",
    title: "Test-to-journey/code-node map",
    description:
      "Returns the test coverage map for a project — every test_id with the journeys and code nodes it exercises. Large responses are written to the blob store and summarised.",
    inputSchema: {
      project_id: z.string(),
      test_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const test_id = input.test_id as string | undefined;
      const all = await ctx.context.coverage.load(project_id);
      const filtered = test_id ? all.filter((t) => t.test_id === test_id) : all;
      if (!filtered.length) {
        return { text: `No coverage entries found for ${project_id}${test_id ? ` / ${test_id}` : ""}.`, structured: { entries: [] } };
      }
      const lines = [`## Test map — ${project_id}${test_id ? ` / ${test_id}` : ""}`, "", `**Entries:** ${filtered.length}`, ""];
      for (const e of filtered.slice(0, 50)) {
        lines.push(`- **\`${e.test_id}\`** — ${e.test_name} (${e.suite})`);
        lines.push(`  journeys: ${e.journey_ids.join(", ") || "(none)"}`);
        lines.push(`  code_nodes: ${e.code_node_ids.slice(0, 5).join(", ")}${e.code_node_ids.length > 5 ? ` (+${e.code_node_ids.length - 5} more)` : ""}`);
      }
      if (filtered.length > 50) lines.push(`_…and ${filtered.length - 50} more entries_`);
      const cache_key = ctx.cache.key("tr_test_map", { project_id, test_id });
      const sha = ctx.cache.blob.write(JSON.stringify(filtered));
      ctx.cache.set(cache_key, { blob: sha }, { ttlSeconds: 900 });
      return { text: lines.join("\n"), structured: { entries: filtered, cache_key }, cacheKey: cache_key };
    },
  },
  {
    name: "tr_coverage_gaps",
    capability: "coverage",
    title: "Ranked coverage gaps",
    description:
      "Returns the top-N user journeys with NO test covering them, ordered by user count. Each gap includes the pp coverage gain we'd get by covering it and any partial overlaps with existing tests.",
    inputSchema: {
      project_id: z.string(),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
    outputSchema: {
      gaps: z.array(
        z.object({
          journey_id: z.string(),
          journey_name: z.string(),
          user_count: z.number(),
          pp_coverage_gain: z.number(),
          events: z.array(z.string()),
        }),
      ),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const limit = (input.limit as number | undefined) ?? 10;
      const gaps = await ctx.context.correlator.rankedGaps(project_id, limit);
      if (!gaps.length) {
        return { text: `🎉 No coverage gaps in top journeys for ${project_id}.`, structured: { gaps: [] } };
      }
      const lines = [`## Coverage gaps — ${project_id}`, "", `**Top ${gaps.length} uncovered journeys (by users):**`, ""];
      for (const g of gaps) {
        lines.push(`- **\`${g.journey_id}\`** — ${g.journey_name}`);
        lines.push(`  ${g.user_count.toLocaleString()} users · +${g.pp_coverage_gain.toFixed(1)}pp user coverage if covered`);
        lines.push(`  ${g.events.join(" → ")}`);
        if (g.partial_overlaps?.length) {
          lines.push(`  partial overlaps: ${g.partial_overlaps.map((o) => `${o.test_id}(${(o.overlap * 100).toFixed(0)}%)`).join(", ")}`);
        }
      }
      lines.push("");
      lines.push("Next step: call `tr_plan_test` with the highest-gain `journey_id` to draft a plan.");
      return { text: lines.join("\n"), structured: { gaps } };
    },
  },
  {
    name: "tr_coverage_report",
    capability: "coverage",
    title: "Coverage report (95% readout)",
    description:
      "Returns user_coverage and test_coverage metrics with progress toward the 95/95 targets. Repeat calls return a 3-state diff (unchanged / diff / full) to cut token usage on iteration.",
    inputSchema: {
      project_id: z.string(),
      read_mode: z.enum(["auto", "full"]).optional().default("auto"),
    },
    outputSchema: {
      user_coverage: z.number(),
      test_coverage: z.number(),
      meets_95_user: z.boolean(),
      meets_95_test: z.boolean(),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const mode = (input.read_mode as string | undefined) ?? "auto";
      const report = await ctx.context.correlator.coverageReport(project_id);
      const correlation = await ctx.context.correlator.correlate(project_id);
      const meets_user = report.user_coverage >= 0.95;
      const meets_test = report.test_coverage >= 0.95;
      const fullText = [
        `## Coverage report — ${project_id}`,
        `_Generated at ${report.generated_at}_`,
        "",
        `| Metric | Value | Target | Status |`,
        `|---|---|---|---|`,
        `| User coverage (unweighted) | ${(report.user_coverage * 100).toFixed(1)}% | 95% | ${meets_user ? "✅" : "⚠️"} |`,
        `| User coverage (weighted by users) | ${(correlation.user_coverage_weighted * 100).toFixed(1)}% | 95% | ${correlation.user_coverage_weighted >= 0.95 ? "✅" : "⚠️"} |`,
        `| Test coverage (code nodes) | ${(report.test_coverage * 100).toFixed(1)}% | 95% | ${meets_test ? "✅" : "⚠️"} |`,
        "",
        `**Total journeys tracked:** ${report.total_journeys}  (${report.covered_journeys} covered, ${report.uncovered_journeys} uncovered)`,
        `**Total users tracked:** ${correlation.total_users_tracked.toLocaleString()}  (${correlation.total_users_covered.toLocaleString()} covered)`,
        "",
        report.gaps_summary.length > 0
          ? "### Top gaps by user count\n" + report.gaps_summary.map((g) => `- \`${g.journey_id}\` (${g.user_count.toLocaleString()} users) — ${g.reason}`).join("\n")
          : "_No gaps in top journeys._",
        "",
        "Next step: call `tr_coverage_gaps` to see the ranked list or `tr_plan_test` on a specific journey.",
      ].join("\n");

      if (mode === "full") {
        return {
          text: fullText,
          structured: {
            report,
            user_coverage: report.user_coverage,
            test_coverage: report.test_coverage,
            meets_95_user: meets_user,
            meets_95_test: meets_test,
          },
        };
      }
      const state = ctx.cache.diff.read(`coverage-report:${project_id}`, fullText);
      if (state.state === "unchanged") {
        return {
          text: [`## Coverage report — ${project_id}`, "", `_Unchanged since the last read (fingerprint ${state.fingerprint}). Call with read_mode=full to force a fresh read._`].join("\n"),
          structured: {
            report,
            user_coverage: report.user_coverage,
            test_coverage: report.test_coverage,
            meets_95_user: meets_user,
            meets_95_test: meets_test,
            read_state: "unchanged",
          },
        };
      }
      if (state.state === "diff") {
        return {
          text: [`## Coverage report — ${project_id} (diff since last read)`, "", "```diff", state.content, "```"].join("\n"),
          structured: {
            report,
            user_coverage: report.user_coverage,
            test_coverage: report.test_coverage,
            meets_95_user: meets_user,
            meets_95_test: meets_test,
            read_state: "diff",
          },
        };
      }
      return {
        text: fullText,
        structured: {
          report,
          user_coverage: report.user_coverage,
          test_coverage: report.test_coverage,
          meets_95_user: meets_user,
          meets_95_test: meets_test,
          read_state: "full",
        },
      };
    },
  },
  {
    name: "tr_fetch_cached",
    capability: "coverage",
    title: "Fetch a cached full payload",
    description:
      "Fetches a payload referenced by a cache_key returned from another tool. Used to opt into large content only when needed (token efficiency).",
    inputSchema: {
      cache_key: z.string(),
    },
    handler: async (input, ctx) => {
      const cache_key = input.cache_key as string;
      const hit = ctx.cache.get<{ blob?: string } | Record<string, unknown>>(cache_key);
      if (!hit) return { text: `No cached value for key ${cache_key}.`, structured: {} };
      const value = hit.value as { blob?: string } & Record<string, unknown>;
      if (value.blob) {
        const text = ctx.cache.blob.readText(value.blob);
        if (!text) return { text: `Blob ${value.blob} missing from L4.`, structured: {} };
        return { text: ["```json", text.slice(0, 12_000), "```"].join("\n"), structured: { blob: value.blob, cache_key } };
      }
      return { text: ["```json", JSON.stringify(value, null, 2), "```"].join("\n"), structured: { value, cache_key } };
    },
  },
];

export function registerCoverageTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of coverageTools) register(t);
}
