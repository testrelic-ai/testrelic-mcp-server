import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../registry/index.js";

/**
 * MCP resources — read-only URIs the client can fetch on demand.
 *
 * URI schemes:
 *   testrelic://projects/{project_id}/journeys
 *   testrelic://projects/{project_id}/coverage-report
 *   testrelic://projects/{project_id}/gaps
 *   testrelic://cache/{key}          (resolves cached blobs)
 */

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "journeys",
    "testrelic://projects/{project_id}/journeys",
    {
      title: "Top user journeys for a project",
      description: "JSON list of top-N user journeys for the given project, Amplitude-derived.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/projects\/([^/]+)\/journeys$/);
      if (!match) throw new Error(`Invalid journeys URI: ${uri.href}`);
      const project_id = decodeURIComponent(match[1] ?? "");
      const journeys = await ctx.context.journeys.top(project_id, 200);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ project_id, journeys }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "coverage-report",
    "testrelic://projects/{project_id}/coverage-report",
    {
      title: "Coverage report (95% readout)",
      description: "User/test coverage, gaps summary, and targets.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/projects\/([^/]+)\/coverage-report$/);
      if (!match) throw new Error(`Invalid coverage-report URI: ${uri.href}`);
      const project_id = decodeURIComponent(match[1] ?? "");
      const report = await ctx.context.correlator.coverageReport(project_id);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  server.registerResource(
    "coverage-gaps",
    "testrelic://projects/{project_id}/gaps",
    {
      title: "Ranked coverage gaps",
      description: "Top-N uncovered journeys ranked by user count.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/projects\/([^/]+)\/gaps$/);
      if (!match) throw new Error(`Invalid gaps URI: ${uri.href}`);
      const project_id = decodeURIComponent(match[1] ?? "");
      const gaps = await ctx.context.correlator.rankedGaps(project_id, 50);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ project_id, gaps }, null, 2) }] };
    },
  );

  server.registerResource(
    "cache-blob",
    "testrelic://cache/{key}",
    {
      title: "Cached payload blob",
      description: "Resolves a cache_key returned by other tools to the full payload.",
      mimeType: "application/octet-stream",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/cache\/([^/]+)$/);
      if (!match) throw new Error(`Invalid cache URI: ${uri.href}`);
      const key = decodeURIComponent(match[1] ?? "");
      const value = ctx.cache.get<{ blob?: string } & Record<string, unknown>>(key);
      if (!value) throw new Error(`No cached value for key ${key}`);
      if (value.value && typeof value.value === "object" && "blob" in value.value && typeof value.value.blob === "string") {
        const text = ctx.cache.blob.readText(value.value.blob);
        return { contents: [{ uri: uri.href, mimeType: "application/octet-stream", text: text ?? "" }] };
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value.value, null, 2) }] };
    },
  );
}
