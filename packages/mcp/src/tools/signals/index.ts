import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";

/**
 * Signals capability — production-signal correlation. Tie test failures to
 * real user impact (Amplitude) and real logs (Loki). Replaces the v1
 * user-impact tools 1:1.
 */

/**
 * "Peak" as the source actually knows it. Loki through the platform has lines,
 * not a rate, so that path reports its busiest minute; printing the old
 * line-count ×100 as a percent produced figures like "50000.00%".
 */
function describePeak(b: {
  error_rate_peak: number;
  peak_per_minute?: number;
  peak_time: string;
  total_errors: number;
  truncated?: boolean;
}): string {
  const total = `${b.total_errors.toLocaleString()}${b.truncated ? "+" : ""}`;
  if (!b.peak_time) return `**Peak:** none — no matching lines · **Matching lines:** ${total}`;
  const peak =
    b.peak_per_minute !== undefined
      ? `${b.peak_per_minute.toLocaleString()} lines/min`
      : `${(b.error_rate_peak * 100).toFixed(2)}%`;
  return `**Peak:** ${peak} @ ${b.peak_time} · **Matching lines:** ${total}`;
}

/** Hours from the run's start to now, so a log window covers the run. */
function hoursSince(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "24h";
  return `${Math.min(720, Math.max(1, Math.ceil((Date.now() - t) / 3_600_000)))}h`;
}

export const signalsTools: ToolDefinition[] = [
  {
    name: "tr_user_impact",
    capability: "signals",
    title: "Correlate a run with user impact",
    description:
      "Pulls Amplitude error-event counts for the run's dates and, given a LogQL `log_query`, matching Loki lines since the run started. Returns the business-level blast radius so the agent can prioritise.",
    inputSchema: {
      run_id: z.string(),
      log_query: z
        .string()
        .optional()
        .describe('LogQL for the service under test, e.g. `{service="checkout"} |= "error"`. Omit to skip Loki.'),
    },
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
      // This used to query `{service="checkout"} |= "timeout"` for every org —
      // someone else's service name, so the "error rate" was unrelated noise.
      const log_query = input.log_query as string | undefined;
      const loki = log_query
        ? await ctx.clients.loki.queryRange(log_query, hoursSince(run.started_at)).catch(() => null)
        : null;
      const text = [
        `## User impact — ${run_id}`,
        "",
        `**Run:** ${run.status} · ${run.failed} failures`,
        `**Amplitude error events (run dates):** ${users.affected_users.toLocaleString()}` +
          `${users.error_path ? ` at \`${users.error_path}\`` : ""}${users.peak_time ? ` (peak ${users.peak_time})` : ""}`,
        loki
          ? `**Loki** \`${log_query}\` since the run started — ${describePeak(loki)}`
          : log_query
            ? "_Loki unavailable — no log signal._"
            : "_No `log_query` given — pass the LogQL for the service under test to add a Loki signal._",
      ].join("\n");
      return {
        text,
        structured: {
          run,
          users,
          loki,
          affected_users: users.affected_users,
          error_rate_peak: loki?.error_rate_peak ?? 0,
          peak_time: loki?.peak_time || undefined,
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
      time_range: z.string().optional().describe("Window ending now: <n>m, <n>h, <n>d or <n>w (e.g. 30m, 24h, 7d). Default 24h"),
      max_lines: z.number().int().optional().default(100),
    },
    aliases: [{ name: "testrelic_get_production_signal", description: "Query Loki for a production signal." }],
    handler: async (input, ctx) => {
      const bucket = await ctx.context.signals.forPattern(input.query as string, input.time_range as string | undefined);
      const maxLines = (input.max_lines as number | undefined) ?? 100;
      const lines = [
        `## Loki — \`${input.query}\``,
        `**Window:** ${bucket.time_range} · ${describePeak(bucket)}`,
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
