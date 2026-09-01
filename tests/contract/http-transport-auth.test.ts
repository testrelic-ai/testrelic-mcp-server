import { describe, it, expect, afterEach } from "vitest";
import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttp } from "../../packages/mcp/src/transport/http.js";
import { resolveConfig, configFromEnv } from "../../packages/mcp/src/config.js";

/**
 * The hole this closes: until 2026-09-01 the HTTP transport read only
 * `mcp-session-id` and never looked at `Authorization`, while every session
 * used the container's own PAT. A hosted deployment therefore executed tool
 * calls for ANYONE who could reach it, as the owning org. Verified against
 * production that day — an unauthenticated `tools/call` returned the org's
 * repository list.
 *
 * These tests pin the gate AND its default, because the default is the part
 * that actually protects a deployment: nobody sets `requireAuth` by hand.
 */

const TOKEN = `tr_mcp_${"a".repeat(64)}`;

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

// A fixed, unusual port per test. The schema requires port >= 1, so 0
// ("let the OS choose") is not expressible through resolveConfig.
let nextPort = 39210;

async function serve(over: Record<string, unknown>) {
  const port = nextPort++;
  const config = resolveConfig({
    cloud: { token: TOKEN, baseUrl: "https://example.invalid/api/v1" },
    server: { port, transport: "http", ...over },
  } as never);
  stop = await startHttp(() => new McpServer({ name: "t", version: "0" }), config);
  return config;
}

const url = (config: { server: { port: number } }, path: string) =>
  `http://127.0.0.1:${config.server.port}${path}`;

const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("http transport caller authentication", () => {
  it("DEFAULTS to required on a non-loopback bind — the reachable case fails closed", () => {
    const c = resolveConfig({
      cloud: { token: TOKEN },
      server: { host: "0.0.0.0", transport: "http" },
    } as never);
    expect(c.server.requireAuth).toBe(true);
  });

  it("defaults to off on loopback, where the machine is the trust boundary", () => {
    const c = resolveConfig({
      cloud: { token: TOKEN },
      server: { host: "127.0.0.1", transport: "http" },
    } as never);
    expect(c.server.requireAuth).toBe(false);
  });

  it("rejects an unauthenticated /mcp call with 401 — the production bug", async () => {
    const c = await serve({ host: "127.0.0.1", requireAuth: true });
    const res = await axios.post(url(c, "/mcp"), rpc, {
      validateStatus: () => true,
      headers: { Accept: "application/json, text/event-stream" },
    });
    expect(res.status).toBe(401);
    expect(res.data?.error?.code).toBe("UNAUTHORIZED");
    expect(String(res.headers["www-authenticate"] ?? "")).toContain("Bearer");
  });

  it("rejects a WRONG bearer token", async () => {
    const c = await serve({ host: "127.0.0.1", requireAuth: true });
    const res = await axios.post(url(c, "/mcp"), rpc, {
      validateStatus: () => true,
      headers: { Authorization: `Bearer tr_mcp_${"b".repeat(64)}`, Accept: "application/json, text/event-stream" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the configured token (and does not 401)", async () => {
    const c = await serve({ host: "127.0.0.1", requireAuth: true });
    const res = await axios.post(url(c, "/mcp"), rpc, {
      validateStatus: () => true,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json, text/event-stream" },
    });
    expect(res.status).not.toBe(401);
  });

  it("leaves /healthz open — the load balancer probes it", async () => {
    const c = await serve({ host: "127.0.0.1", requireAuth: true });
    const res = await axios.get(url(c, "/healthz"), { validateStatus: () => true });
    expect(res.status).toBe(200);
    expect(res.data?.ok).toBe(true);
  });

  it("refuses to start when auth is demanded but no token exists — never serves everyone instead", async () => {
    const config = resolveConfig({
      cloud: { token: "" },
      server: { port: nextPort++, host: "0.0.0.0", transport: "http", requireAuth: true },
    } as never);
    await expect(
      startHttp(() => new McpServer({ name: "t", version: "0" }), config),
    ).rejects.toThrow(/no cloud token is configured/i);
  });

  it("env var forces the setting explicitly, and an UNSET var does not read as false", () => {
    expect(configFromEnv({ TESTRELIC_MCP_REQUIRE_AUTH: "false" } as never).server?.requireAuth).toBe(false);
    expect(configFromEnv({ TESTRELIC_MCP_REQUIRE_AUTH: "true" } as never).server?.requireAuth).toBe(true);
    expect(configFromEnv({} as never).server?.requireAuth).toBeUndefined();
  });
});
