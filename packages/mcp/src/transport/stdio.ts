import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLogger } from "../logger.js";

/**
 * Stdio transport wiring. The MCP SDK handles framing — we just connect.
 */
export async function startStdio(server: McpServer): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  getLogger().info("stdio transport connected");
  return async () => {
    try {
      await transport.close();
    } catch {
      // best effort
    }
  };
}
