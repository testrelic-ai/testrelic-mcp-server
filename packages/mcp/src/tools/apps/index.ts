import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";

/**
 * Connected Apps capability — the generic action runner for any third-party
 * app the org has authorised. Slack, Notion, Linear, HubSpot, Salesforce,
 * Google Calendar, etc. all flow through this surface.
 *
 * The underlying gateway is an implementation detail of the platform. Nothing
 * in this file — names, descriptions, schema field names, error messages —
 * may reference any gateway brand. The `tests/contract/branding.test.ts`
 * lint enforces this at build time.
 */

const AppCatalogEntry = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  connected: z.boolean(),
  connectionId: z.string().nullable(),
});

const ActionEntry = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});

export const appsTools: ToolDefinition[] = [
  {
    name: "tr_apps_list",
    capability: "apps",
    title: "List connected apps",
    description:
      "Catalog of every app the org can connect through the Apps gateway, with current connection state. Each entry has { slug, name, category, connected, connectionId }. Call this before `tr_apps_execute` to confirm the app is connected — if not, run `tr_apps_connect` first.",
    inputSchema: {},
    outputSchema: {
      apps: z.array(AppCatalogEntry),
    },
    handler: async (_input, ctx) => {
      const { apps } = await ctx.clients.cloud.listApps();
      const lines = ["## Connected Apps", ""];
      for (const a of apps) {
        const dot = a.connected ? "●" : "○";
        lines.push(`- ${dot} **${a.slug}** — ${a.name} (${a.category}${a.connected ? `, connection: ${a.connectionId ?? "?"}` : ""})`);
      }
      if (!apps.length) lines.push("_No apps available. Check `apps.enabled` in the bootstrap response._");
      return { text: lines.join("\n"), structured: { apps } };
    },
  },
  {
    name: "tr_apps_list_actions",
    capability: "apps",
    title: "List actions an app exposes",
    description:
      "Returns the action catalog for one connected app. Each action has { name, description, inputSchema }. Use this before `tr_apps_execute` to discover what operations are available (e.g. send_message, create_page, create_issue).",
    inputSchema: {
      app: z.string().describe("App slug from `tr_apps_list`"),
    },
    outputSchema: {
      actions: z.array(ActionEntry),
    },
    handler: async (input, ctx) => {
      const slug = String(input.app);
      const { actions } = await ctx.clients.cloud.listAppActions(slug);
      const lines = [`## Actions: ${slug}`, ""];
      for (const a of actions) lines.push(`- **${a.name}** — ${a.description}`);
      if (!actions.length) lines.push("_No actions available. The app may not be connected, or the gateway returned an empty catalog._");
      return { text: lines.join("\n"), structured: { actions } };
    },
  },
  {
    name: "tr_apps_connect",
    capability: "apps",
    title: "Connect an app",
    description:
      "Initiates an OAuth connection for an app. Returns { redirectUrl, connectionId }. The user must open redirectUrl in a browser and complete the consent flow; the MCP cannot automate this. After consent, the connection becomes ACTIVE — poll `tr_apps_list` to confirm `connected: true`.",
    inputSchema: {
      app: z.string().describe("App slug to connect (from `tr_apps_list`)"),
    },
    outputSchema: {
      redirectUrl: z.string(),
      connectionId: z.string(),
    },
    handler: async (input, ctx) => {
      const slug = String(input.app);
      const result = await ctx.clients.cloud.startAppConnect(slug);
      const text = [
        `## Connect ${slug}`,
        "",
        "Open this URL in a browser and complete the consent flow:",
        "",
        result.redirectUrl,
        "",
        `After consent, this connection becomes active: \`${result.connectionId}\`. Re-run \`tr_apps_list\` to confirm.`,
      ].join("\n");
      return { text, structured: result };
    },
  },
  {
    name: "tr_apps_disconnect",
    capability: "apps",
    title: "Disconnect an app",
    description: "Revokes a connection. Subsequent `tr_apps_execute` calls for the same app will fail until reconnected.",
    inputSchema: {
      connectionId: z.string(),
    },
    outputSchema: { ok: z.boolean() },
    handler: async (input, ctx) => {
      const id = String(input.connectionId);
      const result = await ctx.clients.cloud.disconnectAppConnection(id);
      return { text: `Disconnected ${id}.`, structured: result };
    },
  },
  {
    name: "tr_apps_execute",
    capability: "apps",
    title: "Run an action on a connected app",
    description:
      "Universal action runner. Body: { app, action, args }. Returns { ok, app, action, result }. Examples: send a Slack message, create a Notion page, create a Linear issue, post to HubSpot CRM, create a Google Calendar event, run a Salesforce query. The platform proxies the call using credentials it holds — never pass tokens or secrets in args.",
    inputSchema: {
      app: z.string().describe("App slug from `tr_apps_list`"),
      action: z.string().describe("Action name from `tr_apps_list_actions`"),
      args: z.record(z.unknown()).describe("Action-specific arguments per the action's inputSchema"),
    },
    outputSchema: {
      ok: z.boolean(),
      app: z.string(),
      action: z.string(),
      result: z.record(z.unknown()),
    },
    handler: async (input, ctx) => {
      const app = String(input.app);
      const action = String(input.action);
      const args = (input.args ?? {}) as Record<string, unknown>;
      const result = await ctx.clients.cloud.appExecute({ app, action, args });
      const text = result.ok
        ? `✓ ${app}.${action} succeeded.`
        : `✗ ${app}.${action} failed.`;
      return { text, structured: result };
    },
  },
];
