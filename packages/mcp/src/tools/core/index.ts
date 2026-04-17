import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";
import { version } from "../../version.js";

/**
 * Core capability — always on. Short, cheap introspection tools the agent
 * uses to orient itself before committing to a capability-specific workflow.
 */

export const coreTools: ToolDefinition[] = [
  {
    name: "tr_list_projects",
    capability: "core",
    title: "List TestRelic projects",
    description:
      "Lists repos the authenticated user can see in cloud-platform-app. Sourced from /api/v1/mcp/bootstrap — no upstream fetch per call. Use this first when you don't know which project_id (== repoId) to target.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    outputSchema: {
      projects: z.array(
        z.object({
          project_id: z.string(),
          project_name: z.string(),
          git_id: z.string(),
        }),
      ),
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number | undefined) ?? 20;
      const repos = ctx.bootstrap?.repos ?? [];
      const results = repos.slice(0, limit).map((r) => ({
        project_id: r.id,
        project_name: r.displayName,
        git_id: r.gitId,
      }));
      const lines = ["## Projects", ""];
      for (const p of results) lines.push(`- **${p.project_id}** — ${p.project_name} (git: \`${p.git_id}\`)`);
      if (!results.length) {
        lines.push(
          "_No repos found. Either bootstrap failed (check your MCP token) or this organization has no repos yet._",
        );
      }
      return { text: lines.join("\n"), structured: { projects: results } };
    },
  },
  {
    name: "tr_describe_project",
    capability: "core",
    title: "Describe a project",
    description:
      "Returns a project's integrations and capabilities. Sourced from the startup bootstrap — zero additional upstream calls.",
    inputSchema: {
      project_id: z.string().describe("Project ID (== cloud-platform-app repoId) or git slug"),
    },
    handler: async (input, ctx) => {
      const id = input.project_id as string;
      const repo = ctx.bootstrap?.repos.find((r) => r.id === id || r.gitId === id);
      if (!repo) {
        return {
          text: `Project "${id}" not found. Call \`tr_list_projects\` to see available repos.`,
          structured: { error: { code: "NOT_FOUND" } },
        };
      }
      const integrations = (ctx.bootstrap?.integrations ?? [])
        .filter((i) => i.connected)
        .map((i) => i.type);
      const text = [
        `## ${repo.displayName} (${repo.id})`,
        ``,
        `- **Git slug:** \`${repo.gitId}\``,
        `- **Organization integrations:** ${integrations.length ? integrations.join(", ") : "(none connected)"}`,
        `- **Created:** ${repo.createdAt}`,
      ].join("\n");
      return { text, structured: { project: repo, integrations } };
    },
  },
  {
    name: "tr_integration_status",
    capability: "core",
    title: "Check integration health",
    description:
      "Returns a live health check for one integration type in the current org (e.g. 'jira', 'amplitude', 'grafana-loki'). Call this when a tool that depends on an integration fails with INTEGRATION_NOT_CONNECTED — the error message tells you where to configure it in the cloud UI.",
    inputSchema: {
      type: z.enum(["jira", "amplitude", "grafana-loki", "github-actions"]),
    },
    handler: async (input, ctx) => {
      const type = input.type as string;
      const status = await ctx.clients.cloud.integrationStatus(type).catch((err) => ({
        connected: false,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      const base = ctx.config.cloud.baseUrl.replace(/\/api\/v1\/?$/, "");
      const lines = [
        `## Integration: ${type}`,
        ``,
        `- **Connected:** ${status.connected ? "yes" : "no"}`,
        `- **Credentials valid:** ${status.valid ? "yes" : "no"}`,
      ];
      if (!status.connected || !status.valid) {
        lines.push(`- **Configure at:** ${base}/settings/integrations`);
        if (status.error) lines.push(`- **Last error:** ${status.error}`);
      }
      return { text: lines.join("\n"), structured: { type, ...status } };
    },
  },
  {
    name: "tr_recent_runs",
    capability: "core",
    title: "List recent test runs",
    description:
      "Paginated list of recent runs. Supports filters by project, framework, status. Prefer this as the cheap entry point before diagnosing a specific run.",
    inputSchema: {
      project_id: z.string().optional(),
      framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional(),
      status: z.enum(["passed", "failed", "running", "cancelled"]).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional().default(5),
    },
    handler: async (input, ctx) => {
      const result = await ctx.clients.testrelic.listRuns(input);
      const { data: runs, next_cursor, total } = result;
      if (!runs.length) return { text: "No test runs found matching your filters.", structured: { runs: [], total: 0 } };
      const lines: string[] = [`## Test Runs (${runs.length} of ${total} total)`, ""];
      for (const run of runs) {
        const passRate = run.total > 0 ? ((run.passed / run.total) * 100).toFixed(1) : "0.0";
        const duration = (run.duration_ms / 1000).toFixed(1);
        const status = run.status === "passed" ? "✓ passed" : `✗ ${run.status}`;
        lines.push(
          `- **${run.run_id}** [${status}]  ${run.failed} failed · ${run.flaky} flaky · ${passRate}% pass  |  ${run.framework}  |  ${run.branch}@${run.commit_sha}  |  ${duration}s  |  ${run.started_at}`,
        );
      }
      lines.push("");
      if (next_cursor) lines.push(`**Next page cursor:** \`${next_cursor}\``);
      else lines.push("_No more pages._");
      return { text: lines.join("\n"), structured: { runs, next_cursor, total } };
    },
  },
  {
    name: "tr_get_config",
    capability: "core",
    title: "Resolved server config",
    description:
      "Returns the resolved configuration — capabilities, transport, timeouts, cache/output dirs. Safe to call early to learn what tools/resources are available.",
    inputSchema: {},
    handler: async (_input, ctx) => {
      const cloud = {
        baseUrl: ctx.config.cloud.baseUrl,
        token: ctx.config.cloud.token ? "***" : undefined,
        defaultRepoId: ctx.config.cloud.defaultRepoId,
      };
      const bootstrapIntegrations = ctx.bootstrap?.integrations.map((i) => ({
        type: i.type,
        connected: i.connected,
        capabilities: i.capabilities,
      })) ?? [];
      const payload = {
        version,
        capabilities: ctx.config.capabilities,
        transport: ctx.config.server.transport,
        timeouts: ctx.config.timeouts,
        outputDir: ctx.config.outputDir,
        cacheDir: ctx.config.cacheDir,
        isolated: ctx.config.isolated,
        saveSession: ctx.config.saveSession,
        mockMode: ctx.config.mockMode,
        cloud,
        integrations: bootstrapIntegrations,
        tokenBudgetPerTool: ctx.config.tokenBudgetPerTool,
      };
      return {
        text: ["## TestRelic MCP — resolved config", "", "```json", JSON.stringify(payload, null, 2), "```"].join("\n"),
        structured: payload,
      };
    },
  },
  {
    name: "tr_health",
    capability: "core",
    title: "Server health",
    description:
      "Reports upstream connectivity, cache state, and whether any circuit breakers are open. Call this before a long workflow to fail fast if something is down.",
    inputSchema: {},
    handler: async (_input, ctx) => {
      const stats = ctx.cache.snapshot();
      const cloudOpen = ctx.clients._raw.cloud.isCircuitOpen();
      const integrations = ctx.bootstrap?.integrations.map((i) => ({
        type: i.type,
        connected: i.connected,
      })) ?? [];
      const ok = !cloudOpen && !!ctx.bootstrap;
      const text = [
        `## Health: ${ok ? "OK" : "DEGRADED"}`,
        "",
        "### Cloud connection",
        `- Base URL: ${ctx.config.cloud.baseUrl}`,
        `- Bootstrap: ${ctx.bootstrap ? "ok" : "FAILED"}`,
        `- Circuit breaker: ${cloudOpen ? "OPEN" : "closed"}`,
        "",
        "### Integrations (from bootstrap)",
        ...(integrations.length
          ? integrations.map((i) => `- ${i.type}: ${i.connected ? "connected" : "disconnected"}`)
          : ["_(none configured)_"]),
        "",
        "### Cache",
        `- L1 size: ${stats.lruSize}`,
        `- L1 hits/misses: ${stats.l1Hits}/${stats.l1Misses}`,
        `- L2 hits/misses: ${stats.l2Hits}/${stats.l2Misses}`,
        `- Vector store: ${stats.vectorSize} records`,
      ].join("\n");
      return {
        text,
        structured: {
          ok,
          cloud: { baseUrl: ctx.config.cloud.baseUrl, circuitOpen: cloudOpen, bootstrapOk: !!ctx.bootstrap },
          integrations,
          cache: stats,
          version,
        },
      };
    },
  },
];

export function registerCoreTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const tool of coreTools) register(tool);
}
