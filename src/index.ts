import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { assertTestrelicKey } from "./auth/validate.js";

async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT ?? "stdio";

  // Validate credentials at startup rather than failing mid-tool-call
  assertTestrelicKey();

  const server = createServer();

  if (transport === "http") {
    // Phase 2: Streamable HTTP transport
    // Deferred to Phase 2 — import StreamableHTTPServerTransport here when ready.
    // For now, print a clear message so the agent knows what to do.
    console.error(
      "[testrelic-mcp] HTTP transport is Phase 2 and not yet enabled. " +
        "Set MCP_TRANSPORT=stdio to run in stdio mode."
    );
    process.exit(1);
  }

  // Phase 1: stdio (default) — compatible with Claude Desktop, Cursor, and all MCP-compliant IDE extensions
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  // Log to stderr only — stdout is reserved for the MCP stdio protocol
  console.error("[testrelic-mcp] Server running on stdio transport. Ready.");
}

main().catch((err) => {
  console.error("[testrelic-mcp] Fatal error:", err);
  process.exit(1);
});
