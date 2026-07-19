import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";

/**
 * Marketplace capability — first-class testing-related integrations with
 * bespoke proxies: GitHub Actions, Jira, BrowserStack, LambdaTest, Grafana
 * Loki, Sentry, Amplitude. Unlike the dynamic-Apps gateway, each of these
 * has typed operations and per-repo configuration on the platform.
 */

const AppEntry = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  authMethod: z.string(),
  requiresOAuth: z.boolean(),
  capabilities: z.array(z.string()),
  connected: z.boolean(),
  comingSoon: z.boolean(),
  docsUrl: z.string(),
});

const ConfigField = z.object({
  key: z.string(),
  label: z.string(),
  placeholder: z.string(),
  helperText: z.string().optional(),
  secret: z.boolean().optional(),
});

export const marketplaceTools: ToolDefinition[] = [
  {
    name: "tr_marketplace_list_apps",
    capability: "marketplace",
    title: "List Marketplace apps",
    description:
      "Full Marketplace catalog with connection status. Each entry includes auth method, MCP capabilities unlocked when connected, and a coming-soon flag. Returns roughly 7 first-class testing integrations.",
    inputSchema: {},
    outputSchema: {
      apps: z.array(AppEntry),
    },
    handler: async (_input, ctx) => {
      const { apps } = await ctx.clients.cloud.listMarketplaceApps();
      const lines = ["## Marketplace Apps", ""];
      for (const a of apps) {
        const dot = a.connected ? "●" : a.comingSoon ? "…" : "○";
        const caps = a.capabilities.length ? ` [${a.capabilities.join(", ")}]` : "";
        lines.push(`- ${dot} **${a.slug}** — ${a.name} (${a.category}, ${a.authMethod})${caps}`);
      }
      return { text: lines.join("\n"), structured: { apps } };
    },
  },
  {
    name: "tr_marketplace_get_app",
    capability: "marketplace",
    title: "Get one Marketplace app",
    description: "Returns full detail for one app, including configFields needed by `tr_marketplace_connect`.",
    inputSchema: {
      slug: z.string(),
    },
    outputSchema: {
      slug: z.string(),
      name: z.string(),
      category: z.string(),
      description: z.string(),
      authMethod: z.string(),
      requiresOAuth: z.boolean(),
      capabilities: z.array(z.string()),
      connected: z.boolean(),
      configFields: z.array(ConfigField),
      docsUrl: z.string(),
    },
    handler: async (input, ctx) => {
      const slug = String(input.slug);
      const detail = await ctx.clients.cloud.getMarketplaceApp(slug);
      const lines = [
        `## ${detail.name} (${detail.slug})`,
        "",
        detail.description,
        "",
        `- **Category:** ${detail.category}`,
        `- **Auth method:** ${detail.authMethod}${detail.requiresOAuth ? " (OAuth)" : ""}`,
        `- **Connected:** ${detail.connected ? "yes" : "no"}`,
        `- **Capabilities:** ${detail.capabilities.join(", ")}`,
        `- **Docs:** ${detail.docsUrl}`,
      ];
      if (detail.configFields.length) {
        lines.push("", "### Config fields");
        for (const f of detail.configFields) {
          lines.push(`- \`${f.key}\` — ${f.label}${f.secret ? " (secret)" : ""}`);
        }
      }
      return { text: lines.join("\n"), structured: detail };
    },
  },
  {
    name: "tr_marketplace_list_connections",
    capability: "marketplace",
    title: "List active Marketplace connections",
    description: "Returns just the connected apps for the org, with status and connectedAt.",
    inputSchema: {},
    outputSchema: {
      connections: z.array(z.object({ slug: z.string(), status: z.string(), connectedAt: z.string() })),
    },
    handler: async (_input, ctx) => {
      const { connections } = await ctx.clients.cloud.listMarketplaceConnections();
      const lines = ["## Active connections", ""];
      for (const c of connections) lines.push(`- **${c.slug}** — ${c.status} (since ${c.connectedAt})`);
      if (!connections.length) lines.push("_No active Marketplace connections._");
      return { text: lines.join("\n"), structured: { connections } };
    },
  },
  {
    name: "tr_marketplace_validate",
    capability: "marketplace",
    title: "Validate Marketplace credentials",
    description:
      "Validates credentials for an apikey / basic / pat app without writing them. Returns { ok, error? }. Use this before `tr_marketplace_connect` to surface auth issues without side effects.",
    inputSchema: {
      slug: z.string(),
      credentials: z.record(z.string()),
    },
    outputSchema: { ok: z.boolean(), error: z.string().optional() },
    handler: async (input, ctx) => {
      const result = await ctx.clients.cloud.validateMarketplaceApp(
        String(input.slug),
        input.credentials as Record<string, string>,
      );
      return {
        text: result.ok ? `✓ ${input.slug} credentials valid.` : `✗ ${input.slug}: ${result.error ?? "validation failed"}`,
        structured: result,
      };
    },
  },
  {
    name: "tr_marketplace_connect",
    capability: "marketplace",
    title: "Connect a Marketplace app",
    description:
      "Installs an apikey / basic / pat app. For OAuth apps, use `tr_marketplace_start_oauth` instead. Body: { slug, credentials } — keys must match the app's configFields. Returns { ok, id }.",
    inputSchema: {
      slug: z.string(),
      credentials: z.record(z.string()),
    },
    outputSchema: { ok: z.boolean(), id: z.string() },
    handler: async (input, ctx) => {
      const slug = String(input.slug);
      const result = await ctx.clients.cloud.connectMarketplaceApp(
        slug,
        input.credentials as Record<string, string>,
      );
      return { text: `✓ ${slug} connected (id: ${result.id}).`, structured: result };
    },
  },
  {
    name: "tr_marketplace_start_oauth",
    capability: "marketplace",
    title: "Start OAuth for a Marketplace app",
    description:
      "Returns { redirectUrl, state } for OAuth-only Marketplace apps. The user must open redirectUrl in a browser; the MCP cannot automate this. Poll `tr_marketplace_get_app` until `connected: true`.",
    inputSchema: { slug: z.string() },
    outputSchema: { redirectUrl: z.string(), state: z.string() },
    handler: async (input, ctx) => {
      const slug = String(input.slug);
      const r = await ctx.clients.cloud.startMarketplaceOAuth(slug);
      const text = `Open this URL to complete OAuth for ${slug}:\n\n${r.redirectUrl}`;
      return { text, structured: r };
    },
  },
  {
    name: "tr_marketplace_disconnect",
    capability: "marketplace",
    title: "Disconnect a Marketplace app",
    description: "Removes the app's credentials from the org. Existing test runs are unaffected.",
    inputSchema: { slug: z.string() },
    outputSchema: { ok: z.boolean() },
    handler: async (input, ctx) => {
      const slug = String(input.slug);
      const r = await ctx.clients.cloud.disconnectMarketplaceApp(slug);
      return { text: `Disconnected ${slug}.`, structured: r };
    },
  },
  {
    name: "tr_marketplace_invoke",
    capability: "marketplace",
    title: "Invoke a Marketplace operation",
    description:
      "Unified operation runner. Body: { slug, operation, args }. Each app exposes typed operations — e.g. jira.search, jira.create, github.runs, github.trigger, amplitude.events, browserstack.video, sentry.search, loki.query. The platform proxies using stored credentials; never pass tokens or secrets in args.",
    inputSchema: {
      slug: z.string(),
      operation: z.string(),
      args: z.record(z.unknown()),
    },
    outputSchema: {
      ok: z.boolean(),
      operation: z.string(),
      result: z.record(z.unknown()),
    },
    handler: async (input, ctx) => {
      const slug = String(input.slug);
      const op = String(input.operation);
      const r = await ctx.clients.cloud.invokeMarketplaceApp(slug, op, (input.args ?? {}) as Record<string, unknown>);
      return { text: r.ok ? `✓ ${slug}.${op} succeeded.` : `✗ ${slug}.${op} failed.`, structured: r };
    },
  },
];
