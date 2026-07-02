import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { getLogger } from "../logger.js";
import type { ResolvedConfig } from "../config.js";
import { version } from "../version.js";

/**
 * Streamable HTTP transport. One Express server, two relevant routes:
 *   GET  /healthz — JSON health probe
 *   POST /mcp     — MCP JSON-RPC
 *
 * Session management is by the `Mcp-Session-Id` header per the spec.
 *
 * `McpServer` is a single-connection object — it throws on a second
 * `connect()`. For Streamable HTTP we therefore build a fresh server
 * per session via the `buildServer` factory. Subsequent requests on
 * the same session are routed to the already-connected transport.
 */

/** Format a host + port into a canonical HTTP `Host` header value. */
function toHostHeader(host: string, port: number): string {
  // IPv6 literals must be bracketed in a Host header (`[::1]:3000`).
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${bracketed}:${port}`;
}

/** True for loopback hosts (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Build the DNS-rebinding allow-list: the loopback names plus the explicitly
 * configured host, on our port. A browser page that rebinds a DNS name to
 * 127.0.0.1 sends its *own* hostname in the Host header, which will not match
 * any entry here and is rejected by the transport.
 */
export function buildAllowList(host: string, port: number): { allowedHosts: string[]; allowedOrigins: string[] } {
  const hosts = new Set<string>([
    toHostHeader("127.0.0.1", port),
    toHostHeader("localhost", port),
    toHostHeader("::1", port),
    toHostHeader(host, port),
  ]);
  // Standard ports may arrive without an explicit `:port` in the Host header.
  if (port === 80 || port === 443) {
    for (const h of [...hosts]) hosts.add(h.replace(/:\d+$/, ""));
  }
  const origins = new Set<string>();
  for (const h of hosts) {
    origins.add(`http://${h}`);
    origins.add(`https://${h}`);
  }
  return { allowedHosts: [...hosts], allowedOrigins: [...origins] };
}

export async function startHttp(
  buildServer: () => McpServer,
  config: ResolvedConfig,
): Promise<() => Promise<void>> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const port = config.server.port || 3000;
  const host = config.server.host || "127.0.0.1";

  // DNS-rebinding protection. Every session transport enforces this allow-list
  // of Host/Origin values so a malicious web page cannot drive this server via
  // the user's browser.
  const { allowedHosts, allowedOrigins } = buildAllowList(host, port);

  if (!isLoopbackHost(host)) {
    getLogger().warn(
      { host, port },
      "http transport is bound to a non-loopback host — the MCP server is reachable off this machine. " +
        "Bind to 127.0.0.1 unless it sits behind an authenticating proxy you trust.",
    );
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version, transport: "http", capabilities: config.capabilities });
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionHeader = req.header("mcp-session-id");
    let transport = sessionHeader ? transports.get(sessionHeader) : undefined;

    if (!transport) {
      const newSessionId = randomUUID();
      const sessionServer = buildServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
          servers.set(id, sessionServer);
        },
        onsessionclosed: (id: string) => {
          transports.delete(id);
          const s = servers.get(id);
          servers.delete(id);
          if (s) void s.close().catch(() => undefined);
        },
      });
      await sessionServer.connect(transport);
    }

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      getLogger().error({ err }, "http transport request failed");
      if (!res.headersSent) res.status(500).json({ error: "transport error" });
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionHeader = req.header("mcp-session-id");
    const transport = sessionHeader ? transports.get(sessionHeader) : undefined;
    if (!transport) {
      res.status(400).json({ error: "missing or invalid mcp-session-id" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionHeader = req.header("mcp-session-id");
    const transport = sessionHeader ? transports.get(sessionHeader) : undefined;
    if (!transport) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    await transport.close();
    transports.delete(sessionHeader!);
    const s = servers.get(sessionHeader!);
    servers.delete(sessionHeader!);
    if (s) await s.close().catch(() => undefined);
    res.json({ ok: true });
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(port, host, () => {
      getLogger().info({ host, port, version, capabilities: config.capabilities }, "http transport listening");
      resolve(async () => {
        for (const [, t] of transports) {
          try {
            await t.close();
          } catch {
            // ignore
          }
        }
        transports.clear();
        for (const [, s] of servers) {
          try {
            await s.close();
          } catch {
            // ignore
          }
        }
        servers.clear();
        await new Promise<void>((done) => httpServer.close(() => done()));
      });
    });
  });
}
