import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";

/**
 * Signals capability — production-signal correlation. Tie test failures to
 * real user impact (Amplitude) and real logs (Loki). Replaces the v1
 * user-impact tools 1:1.
 */

export const signalsTools: ToolDefinition[] = [
  {
    name: "tr_user_impact",
    capability: "signals",
    title: "Correlate a run with user impact",
    description:
      "Pulls Amplitude affected-user counts and Loki error-rate for a failing run. Returns the business-level blast radius so the agent can prioritise.",
    inputSchema: { run_id: z.string() },
    aliases: [{ name: "testrelic_correlate_user_impact", description: "Correlate run failures with user impact." }],
    outputSchema: {
      affected_users: z.number(),
      error_rate_peak: z.number(),
      peak_time: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const [run, users] = await Promise.all([
        ctx.clients.testrelic.getRun(run_id),
        ctx.clients.amplitude.getUserCount(run_id),
      ]);
      const loki = await ctx.clients.loki
        .queryRange(`{service="checkout"} |= "timeout"`, "24h")
        .catch(() => null);
      const text = [
        `## User impact — ${run_id}`,
        "",
        `**Run:** ${run.status} · ${run.failed} failures`,
        `**Users affected:** ${users.affected_users.toLocaleString()} at \`${users.error_path}\` (peak ${users.peak_time})`,
        loki
          ? `**Error-rate peak:** ${(loki.error_rate_peak * 100).toFixed(2)}% @ ${loki.peak_time} (${loki.total_errors.toLocaleString()} events)`
          : "_Loki unavailable — no error rate signal._",
      ].join("\n");
      return {
        text,
        structured: {
          run,
          users,
          loki,
          affected_users: users.affected_users,
          error_rate_peak: loki?.error_rate_peak ?? 0,
          peak_time: loki?.peak_time,
        },
      };
    },
  },
  {
    name: "tr_production_signal",
    capability: "signals",
    title: "Query production logs (Loki) for a signal",
    description: "Ad-hoc Loki LogQL query over a time window. Results are trimmed and cached (5 min TTL).",
    inputSchema: {
      query: z.string().describe("Loki LogQL query, e.g. `{service=\"checkout\"} |= \"timeout\"`"),
      time_range: z.string().optional().describe("e.g. 1h / 24h / 7d"),
      max_lines: z.number().int().optional().default(100),
    },
    aliases: [{ name: "testrelic_get_production_signal", description: "Query Loki for a production signal." }],
    handler: async (input, ctx) => {
      const bucket = await ctx.context.signals.forPattern(input.query as string, input.time_range as string | undefined);
      const maxLines = (input.max_lines as number | undefined) ?? 100;
      const lines = [
        `## Loki — \`${input.query}\``,
        `**Window:** ${bucket.time_range} · **Peak:** ${(bucket.error_rate_peak * 100).toFixed(2)}% @ ${bucket.peak_time} · **Total errors:** ${bucket.total_errors.toLocaleString()}`,
        "",
        "```log",
        ...bucket.log_lines.slice(0, maxLines).map((l) => `${l.timestamp} [${l.level}] ${l.service} ${l.message}`),
        "```",
      ].join("\n");
      return { text: lines, structured: { bucket } };
    },
  },
  {
    name: "tr_affected_sessions",
    capability: "signals",
    title: "Amplitude sessions hit by a run's failures",
    description: "Returns Amplitude sessions affected by a failing run (cohort for targeted communication or rollback).",
    inputSchema: {
      run_id: z.string(),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    aliases: [{ name: "testrelic_get_affected_sessions", description: "Amplitude sessions affected by a run." }],
    handler: async (input, ctx) => {
      const result = await ctx.clients.amplitude.getSessions(input.run_id as string, input.limit as number | undefined);
      const lines = [`## Affected sessions — ${result.run_id}`, "", `**Total:** ${result.total.toLocaleString()}`, ""];
      for (const s of result.sessions) {
        lines.push(`- \`${s.session_id}\` · user=${s.user_id} · ${s.device_type} · ${s.country} · ${s.error_event} @ ${s.occurred_at}`);
      }
      return { text: lines.join("\n"), structured: result };
    },
  },
];

export function registerSignalsTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of signalsTools) register(t);
}
