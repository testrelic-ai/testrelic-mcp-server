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
 */
export async function startHttp(server: McpServer, config: ResolvedConfig): Promise<() => Promise<void>> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version, transport: "http", capabilities: config.capabilities });
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionHeader = req.header("mcp-session-id");
    let transport = sessionHeader ? transports.get(sessionHeader) : undefined;

    if (!transport) {
      const newSessionId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
        },
        onsessionclosed: (id: string) => {
          transports.delete(id);
        },
      });
      await server.connect(transport);
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
    res.json({ ok: true });
  });

  const port = config.server.port || 3000;
  const host = config.server.host || "127.0.0.1";
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
        await new Promise<void>((done) => httpServer.close(() => done()));
      });
    });
  });
}
