import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "testrelic-mcp-server",
    version: "1.0.0",
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
