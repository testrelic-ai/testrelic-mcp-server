import { describe, it, expect } from "vitest";
import { z } from "zod";
import { cloudOps } from "../../packages/mcp/src/clients/cloud.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import type { ToolContext, ToolDefinition } from "../../packages/mcp/src/registry/index.js";
import type { ServiceClient } from "../../packages/mcp/src/clients/http.js";

/**
 * Regression: `tr_marketplace_list_apps` failed 100% of the time against prod
 * with "Output validation error" — no result ever reached the client.
 *
 * Root cause: the tool declared `comingSoon: z.boolean()` (required), but the
 * platform only serialises that flag when it is TRUE. Six of prod's seven
 * catalog rows omit it entirely, so the MCP SDK's outputSchema check rejected
 * the whole payload. The mock server set `comingSoon` on every row, so the
 * mismatch was invisible locally.
 *
 * Two gates are pinned here:
 *   1. the prod payload shape (flag omitted, plus the undeclared
 *      `configFields` the list endpoint also returns);
 *   2. structured output actually parsing against the tool's own
 *      `outputSchema` — the check the SDK performs at runtime, which neither
 *      the token baselines nor `scripts/smoke-e2e.ts` exercised because both
 *      call `tool.handler()` directly and never validate its output.
 *
 * Same failure mode as TEAI-262 (see run-drilldown-shapes.test.ts): a mock
 * that is kinder than prod hides a shape mismatch until a customer hits it.
 */

function stubClient(routes: Record<string, unknown>): ServiceClient {
  return {
    get: async (url: string) => {
      const path = url.split("?")[0];
      if (!(path in routes)) throw new Error(`no stub for ${path}`);
      const v = routes[path];
      if (v instanceof Error) throw v;
      return v;
    },
    post: async () => {
      throw new Error("no post stub");
    },
  } as unknown as ServiceClient;
}

function ctxWith(routes: Record<string, unknown>): ToolContext {
  return { clients: { cloud: cloudOps(stubClient(routes)) } } as unknown as ToolContext;
}

function tool(name: string): ToolDefinition {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t;
}

/**
 * Runs the same validation the MCP SDK applies to `structuredContent` before
 * it goes over the wire. Throws exactly where a live client would fail.
 */
function parseAgainstOutputSchema(def: ToolDefinition, structured: unknown): unknown {
  if (!def.outputSchema) throw new Error(`${def.name} declares no outputSchema`);
  return z.object(def.outputSchema).parse(structured);
}

/** Verbatim prod rows (2026-08-04, platform.testrelic.ai): note the missing
 *  `comingSoon` on every non-coming-soon app, and `configFields` on all. */
const PROD_APPS = [
  {
    slug: "github-actions",
    name: "GitHub Actions",
    category: "ci",
    description: "Trigger workflows, view run status, and correlate CI builds with test results.",
    authMethod: "pat",
    requiresOAuth: false,
    capabilities: ["github.runs", "github.logs", "github.trigger"],
    configFields: [{ key: "owner", label: "Owner (org or user)", placeholder: "e.g. acme-corp" }],
    docsUrl: "https://docs.github.com/en/actions",
    connected: true,
  },
  {
    slug: "grafana-loki",
    name: "Grafana Loki",
    category: "observability",
    description: "Query and correlate application logs from Grafana Loki with test failures.",
    authMethod: "basic",
    requiresOAuth: false,
    capabilities: ["loki.query"],
    comingSoon: true,
    configFields: [{ key: "url", label: "Loki URL", placeholder: "https://loki.company.com" }],
    docsUrl: "https://grafana.com/docs/loki/latest/",
    connected: false,
  },
];

describe("tr_marketplace_list_apps tolerates the platform's real catalog shape", () => {
  it("passes its own outputSchema when the platform omits comingSoon (the prod bug)", async () => {
    const def = tool("tr_marketplace_list_apps");
    const res = await def.handler({}, ctxWith({ "/mcp/marketplace/apps": { apps: PROD_APPS } }));

    // This is the assertion that used to throw "Output validation error".
    const parsed = parseAgainstOutputSchema(def, res.structured) as {
      apps: Array<{ slug: string; comingSoon: boolean }>;
    };
    expect(parsed.apps).toHaveLength(2);
    expect(parsed.apps[0]?.comingSoon).toBe(false); // defaulted, not dropped
    expect(parsed.apps[1]?.comingSoon).toBe(true); // preserved when sent
  });

  it("marks a coming-soon app with … and a connected app with ● in the text summary", async () => {
    const def = tool("tr_marketplace_list_apps");
    const res = await def.handler({}, ctxWith({ "/mcp/marketplace/apps": { apps: PROD_APPS } }));
    expect(res.text).toContain("● **github-actions**");
    expect(res.text).toContain("… **grafana-loki**");
  });

  it("does not forward configFields — the list schema does not declare them", async () => {
    const def = tool("tr_marketplace_list_apps");
    const res = await def.handler({}, ctxWith({ "/mcp/marketplace/apps": { apps: PROD_APPS } }));
    const { apps } = res.structured as { apps: Array<Record<string, unknown>> };
    for (const a of apps) expect(a).not.toHaveProperty("configFields");
  });

  it("still passes when every app carries an explicit comingSoon", async () => {
    const def = tool("tr_marketplace_list_apps");
    const apps = PROD_APPS.map((a) => ({ ...a, comingSoon: a.comingSoon ?? false }));
    const res = await def.handler({}, ctxWith({ "/mcp/marketplace/apps": { apps } }));
    expect(() => parseAgainstOutputSchema(def, res.structured)).not.toThrow();
  });

  it("returns an empty catalog without throwing", async () => {
    const def = tool("tr_marketplace_list_apps");
    const res = await def.handler({}, ctxWith({ "/mcp/marketplace/apps": { apps: [] } }));
    expect(() => parseAgainstOutputSchema(def, res.structured)).not.toThrow();
  });
});

describe("marketplace read tools validate against their declared outputSchema", () => {
  it("tr_marketplace_get_app parses the prod detail shape", async () => {
    const def = tool("tr_marketplace_get_app");
    const res = await def.handler(
      { slug: "grafana-loki" },
      ctxWith({ "/mcp/marketplace/apps/grafana-loki": PROD_APPS[1] }),
    );
    expect(() => parseAgainstOutputSchema(def, res.structured)).not.toThrow();
  });

  it("tr_marketplace_list_connections parses the prod connections shape", async () => {
    const def = tool("tr_marketplace_list_connections");
    const res = await def.handler(
      {},
      ctxWith({
        "/mcp/marketplace/connections": {
          connections: [{ slug: "jira", status: "connected", connectedAt: "2026-04-01T22:34:05.451Z" }],
        },
      }),
    );
    expect(() => parseAgainstOutputSchema(def, res.structured)).not.toThrow();
  });

  it("tr_apps_list parses the prod gateway shape (null connectionId when unconnected)", async () => {
    const def = tool("tr_apps_list");
    const res = await def.handler(
      {},
      ctxWith({
        "/mcp/apps": {
          apps: [
            { slug: "slack", name: "Slack", category: "app", connected: false, connectionId: null },
            { slug: "github", name: "GitHub", category: "app", connected: true, connectionId: "ca_9hK0U0OkT8pa" },
          ],
        },
      }),
    );
    expect(() => parseAgainstOutputSchema(def, res.structured)).not.toThrow();
  });
});
