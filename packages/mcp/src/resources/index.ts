import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../registry/index.js";

/**
 * MCP resources — read-only URIs the client can fetch on demand.
 *
 * URI schemes:
 *   testrelic://repos/{repo_id}/journeys
 *   testrelic://repos/{repo_id}/coverage-report
 *   testrelic://repos/{repo_id}/gaps
 *   testrelic://cache/{key}                                  (resolves cached blobs)
 *   testrelic://ai/conversations/{id}                        (AI conversation transcript)
 *   testrelic://ai/conversations/{id}/artifacts              (artifacts in a conversation)
 *   testrelic://artifacts/{id}                               (single artifact payload, JSON)
 *   testrelic://marketplace/apps                             (marketplace catalog)
 *   testrelic://marketplace/apps/{slug}                      (marketplace app detail)
 *   testrelic://apps                                         (connected apps — not "toolkits")
 *   testrelic://apps/{slug}/actions                          (actions exposed by a connected app)
 *   testrelic://sessions/{provider}/{sessionId}              (session stub — partially implemented)
 */

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "journeys",
    "testrelic://repos/{repo_id}/journeys",
    {
      title: "Top user journeys for a repo",
      description: "JSON list of top-N user journeys for the given repo, Amplitude-derived.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/repos\/([^/]+)\/journeys$/);
      if (!match) throw new Error(`Invalid journeys URI: ${uri.href}`);
      const repo_id = decodeURIComponent(match[1] ?? "");
      const journeys = await ctx.context.journeys.top(repo_id, 200);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ repo_id, journeys }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "coverage-report",
    "testrelic://repos/{repo_id}/coverage-report",
    {
      title: "Coverage report (95% readout)",
      description: "User/test coverage, gaps summary, and targets.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/repos\/([^/]+)\/coverage-report$/);
      if (!match) throw new Error(`Invalid coverage-report URI: ${uri.href}`);
      const repo_id = decodeURIComponent(match[1] ?? "");
      const report = await ctx.context.correlator.coverageReport(repo_id);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  server.registerResource(
    "coverage-gaps",
    "testrelic://repos/{repo_id}/gaps",
    {
      title: "Ranked coverage gaps",
      description: "Top-N uncovered journeys ranked by user count.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/repos\/([^/]+)\/gaps$/);
      if (!match) throw new Error(`Invalid gaps URI: ${uri.href}`);
      const repo_id = decodeURIComponent(match[1] ?? "");
      const gaps = await ctx.context.correlator.rankedGaps(repo_id, 50);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ repo_id, gaps }, null, 2) }] };
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

  // ── AI conversation surface ───────────────────────────────────────────────
  server.registerResource(
    "ai-conversation",
    "testrelic://ai/conversations/{id}",
    {
      title: "Ask-AI conversation transcript",
      description: "Full message transcript (including artifacts) for a single Ask-AI conversation.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/ai\/conversations\/([^/]+)$/);
      if (!match) throw new Error(`Invalid ai-conversation URI: ${uri.href}`);
      const id = decodeURIComponent(match[1] ?? "");
      const conversation = await ctx.clients.cloud.getConversation(id);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(conversation, null, 2) }],
      };
    },
  );

  server.registerResource(
    "ai-conversation-artifacts",
    "testrelic://ai/conversations/{id}/artifacts",
    {
      title: "Artifacts produced inside an Ask-AI conversation",
      description: "Listing of artifacts (reports, plans, diagrams) generated within a specific conversation.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/ai\/conversations\/([^/]+)\/artifacts$/);
      if (!match) throw new Error(`Invalid ai-conversation-artifacts URI: ${uri.href}`);
      const id = decodeURIComponent(match[1] ?? "");
      const artifacts = await ctx.clients.cloud.listArtifacts({ conversationId: id });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(artifacts, null, 2) }],
      };
    },
  );

  server.registerResource(
    "artifact",
    "testrelic://artifacts/{id}",
    {
      title: "Single AI-generated artifact",
      description:
        "Structured JSON payload for one artifact. Format-specific exports (PDF/PNG) go through tr_artifacts_export.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/artifacts\/([^/]+)$/);
      if (!match) throw new Error(`Invalid artifact URI: ${uri.href}`);
      const id = decodeURIComponent(match[1] ?? "");
      const artifact = await ctx.clients.cloud.getArtifact(id);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(artifact, null, 2) }],
      };
    },
  );

  // ── Marketplace surface ───────────────────────────────────────────────────
  server.registerResource(
    "marketplace-apps",
    "testrelic://marketplace/apps",
    {
      title: "Marketplace catalog",
      description: "Catalog of all marketplace apps available for connection.",
      mimeType: "application/json",
    },
    async (uri) => {
      const apps = await ctx.clients.cloud.listMarketplaceApps();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(apps, null, 2) }],
      };
    },
  );

  server.registerResource(
    "marketplace-app",
    "testrelic://marketplace/apps/{slug}",
    {
      title: "Marketplace app detail",
      description: "Full detail (auth method, config fields, capabilities) for a single marketplace app.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/marketplace\/apps\/([^/]+)$/);
      if (!match) throw new Error(`Invalid marketplace-app URI: ${uri.href}`);
      const slug = decodeURIComponent(match[1] ?? "");
      const app = await ctx.clients.cloud.getMarketplaceApp(slug);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(app, null, 2) }],
      };
    },
  );

  // ── Connected Apps surface ────────────────────────────────────────────────
  server.registerResource(
    "apps",
    "testrelic://apps",
    {
      title: "Connected apps",
      description: "Catalog of connected apps available to the user.",
      mimeType: "application/json",
    },
    async (uri) => {
      const apps = await ctx.clients.cloud.listApps();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(apps, null, 2) }],
      };
    },
  );

  server.registerResource(
    "app-actions",
    "testrelic://apps/{slug}/actions",
    {
      title: "Actions exposed by a connected app",
      description: "List of actions (with input schemas) callable on a specific connected app.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/apps\/([^/]+)\/actions$/);
      if (!match) throw new Error(`Invalid app-actions URI: ${uri.href}`);
      const slug = decodeURIComponent(match[1] ?? "");
      const actions = await ctx.clients.cloud.listAppActions(slug);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(actions, null, 2) }],
      };
    },
  );

  // ── Sessions surface (stub) ───────────────────────────────────────────────
  server.registerResource(
    "session",
    "testrelic://sessions/{provider}/{sessionId}",
    {
      title: "Provider session (stub)",
      description:
        "Placeholder for the sessions surface (Amplitude, OpenObserve, etc.). Currently returns a not_yet_implemented stub.",
      mimeType: "application/json",
    },
    async (uri) => {
      const match = uri.pathname.match(/^\/sessions\/([^/]+)\/([^/]+)$/);
      if (!match) throw new Error(`Invalid session URI: ${uri.href}`);
      const provider = decodeURIComponent(match[1] ?? "");
      const sessionId = decodeURIComponent(match[2] ?? "");
      const payload = { provider, sessionId, status: "not_yet_implemented" as const };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
