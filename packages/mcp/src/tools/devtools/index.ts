import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";

/**
 * Devtools capability — orientation tools for the engineer operating the
 * agent. Project trends, active platform alerts, cache inspection, and a
 * lightweight semantic search over the code map.
 */

export const devtoolsTools: ToolDefinition[] = [
  {
    name: "tr_project_trends",
    capability: "devtools",
    title: "Project quality trends",
    description: "Returns pass-rate, duration, and flakiness trends for a project over the last N days.",
    inputSchema: { project_id: z.string(), days: z.number().int().min(1).max(90).optional().default(7) },
    aliases: [{ name: "testrelic_get_project_trends", description: "Project quality trends." }],
    handler: async (input, ctx) => {
      const trends = await ctx.clients.testrelic.getProjectTrends(input.project_id as string);
      const recent = trends.data.slice(-(input.days as number | undefined ?? 7));
      const lines = [`## Trends — ${trends.project_id} (${recent.length}d)`, "", "| Date | Pass rate | Runs | Avg duration (s) | Flaky |", "|---|---|---|---|---|"];
      for (const p of recent) {
        lines.push(`| ${p.date} | ${(p.pass_rate * 100).toFixed(1)}% | ${p.total_runs} | ${(p.avg_duration_ms / 1000).toFixed(1)} | ${p.flaky_count} |`);
      }
      return { text: lines.join("\n"), structured: { trends: { ...trends, data: recent } } };
    },
  },
  {
    name: "tr_active_alerts",
    capability: "devtools",
    title: "Active platform alerts",
    description: "Returns active TestRelic platform alerts (flakiness spikes, pass-rate drops, etc.).",
    inputSchema: {},
    aliases: [{ name: "testrelic_get_active_alerts", description: "Active platform alerts." }],
    handler: async (_input, ctx) => {
      const alerts = await ctx.clients.testrelic.getActiveAlerts();
      if (!alerts.length) return { text: "No active alerts.", structured: { alerts: [] } };
      const lines = [`## Active alerts (${alerts.length})`, ""];
      for (const a of alerts) {
        lines.push(`- **[${a.severity.toUpperCase()}]** ${a.type} — ${a.message}`);
        lines.push(`  project=${a.project_id} triggered=${a.triggered_at}${a.run_id ? ` run=${a.run_id}` : ""}`);
      }
      return { text: lines.join("\n"), structured: { alerts } };
    },
  },
  {
    name: "tr_search_code",
    capability: "devtools",
    title: "Semantic search over the code map",
    description:
      "Vector search across indexed code nodes. Returns top-k neighbors with score and location. Requires a prior tr_index_repo or platform code map load.",
    inputSchema: {
      query: z.string(),
      k: z.number().int().min(1).max(20).optional().default(6),
    },
    handler: async (input, ctx) => {
      const results = await ctx.context.code.search(input.query as string, input.k as number | undefined);
      if (!results.length) return { text: "No matches. Did you run `tr_index_repo` first?", structured: { results: [] } };
      const lines = [`## Code search — \`${input.query}\``, ""];
      for (const r of results) {
        lines.push(`- **${r.id}** (score ${r.score.toFixed(3)}) — ${r.text}`);
      }
      return { text: lines.join("\n"), structured: { results } };
    },
  },
  {
    name: "tr_index_repo",
    capability: "devtools",
    title: "Index a local repo into the code map",
    description:
      "Walks a local repo root, extracts function/class nodes (tree-sitter when available, regex fallback), and indexes them in the vector store for tr_search_code.",
    inputSchema: {
      repo_root: z.string().describe("Absolute path to the repo root"),
      max_files: z.number().int().optional().default(2500),
    },
    handler: async (input, ctx) => {
      const nodes = await ctx.context.code.loadLocal(input.repo_root as string, {
        maxFiles: input.max_files as number | undefined,
      });
      return {
        text: `Indexed ${nodes.length} code nodes from ${input.repo_root}.`,
        structured: { count: nodes.length, repo_root: input.repo_root },
      };
    },
  },
  {
    name: "tr_cache_stats",
    capability: "devtools",
    title: "Cache stats",
    description: "Returns L1/L2/L3/L4 cache counters. Useful for verifying token reduction in benchmarks.",
    inputSchema: {},
    handler: async (_input, ctx) => {
      const s = ctx.cache.snapshot();
      const text = [
        `## Cache`,
        `- L1 hits/misses: ${s.l1Hits}/${s.l1Misses}  size: ${s.lruSize}`,
        `- L2 hits/misses: ${s.l2Hits}/${s.l2Misses}`,
        `- L3 hits/misses: ${s.l3Hits}/${s.l3Misses}  size: ${s.vectorSize}`,
        `- L4 hits/misses: ${s.l4Hits}/${s.l4Misses}`,
      ].join("\n");
      return { text, structured: { cache: s } };
    },
  },
];

export function registerDevtoolsTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of devtoolsTools) register(t);
}
