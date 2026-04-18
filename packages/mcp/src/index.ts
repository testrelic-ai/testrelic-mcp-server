import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { mergeConfig, configFromEnv, resolveConfig, type ResolvedConfig } from "./config.js";
import { createLogger, getLogger } from "./logger.js";
import { metrics } from "./telemetry/metrics.js";
import { CacheManager } from "./cache/index.js";
import { buildClients } from "./clients/index.js";
import { buildContextEngine } from "./context/index.js";
import { SamplingBridge } from "./sampling/bridge.js";
import { Elicitor } from "./elicit/ask.js";
import { ToolRegistry, type ToolContext } from "./registry/index.js";
import { registerAllTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { version, name } from "./version.js";
import { startStdio } from "./transport/stdio.js";
import { startHttp } from "./transport/http.js";

/**
 * Programmatic API — this is the entry point that the CLI uses and also
 * what library consumers import via `import { createServer } from "@testrelic/mcp"`.
 *
 * @example
 *   import { createServer } from "@testrelic/mcp";
 *   const { server, start, stop } = await createServer({ capabilities: ["coverage"] });
 *   await start();
 *   // ... later
 *   await stop();
 */

export interface TestRelicServer {
  /** The underlying MCP server instance — do not mutate. */
  server: McpServer;
  /** Resolved config (defaults, env, and caller-provided merged). */
  config: ResolvedConfig;
  /** Registered tool list for logging/documentation. */
  registeredTools: Array<{ name: string; capability: string; deprecated: boolean }>;
  /** Start the transport (stdio or http based on config). */
  start(): Promise<void>;
  /** Gracefully shut down the transport and flush telemetry. */
  stop(): Promise<void>;
  /**
   * INTERNAL — tool context exposed for tests. Not part of the public API.
   * Do not use in production code; reach for the MCP protocol instead.
   */
  __ctx: ToolContext;
}

export async function createServer(inputConfig: Config = {}): Promise<TestRelicServer> {
  const config = resolveConfig(mergeConfig(configFromEnv(), inputConfig));
  createLogger(config.logLevel);

  const server = new McpServer(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      },
      instructions:
        "TestRelic MCP — intelligent testing context for creation, healing, coverage, and impact. Start with `tr_list_repos` or `tr_coverage_report` to orient; capabilities are gated by the --caps flag to keep the tool schema small.",
    },
  );

  metrics.init(config.outputDir);

  const cache = new CacheManager(config);
  await cache.init();

  const clients = buildClients(config);
  const context = buildContextEngine(clients, cache);
  const sampling = new SamplingBridge(server);
  const elicit = new Elicitor(server);

  // Best-effort bootstrap: one shot to /api/v1/mcp/bootstrap to pull the
  // authenticated user/org/repo/integration summary. We never block startup
  // on this — missing bootstrap just means repo_id must be given explicitly.
  let bootstrap: Awaited<ReturnType<typeof clients.cloud.bootstrap>> | undefined;
  try {
    bootstrap = await clients.cloud.bootstrap();
    getLogger().info(
      {
        org: bootstrap.organization.id,
        repos: bootstrap.repos.length,
        integrations: bootstrap.integrations.filter((i) => i.connected).map((i) => i.type),
      },
      "mcp bootstrap ok",
    );
  } catch (err) {
    getLogger().warn(
      { err: (err as Error).message, cloudUrl: config.cloud.baseUrl },
      "mcp bootstrap failed — continuing without repo/integration discovery",
    );
  }

  const registry = new ToolRegistry();
  const toolCtx: ToolContext = { server, config, clients, context, cache, sampling, elicit, bootstrap };
  registerAllTools(toolCtx, registry);
  registerResources(server, toolCtx);
  registerPrompts(server);

  let stopTransport: (() => Promise<void>) | null = null;
  let stopped = false;

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    getLogger().info("shutting down");
    if (stopTransport) {
      await stopTransport().catch((err) => getLogger().warn({ err }, "transport close failed"));
    }
    await cache.close().catch((err) => getLogger().warn({ err }, "cache close failed"));
    await metrics.close();
    try {
      await server.close();
    } catch {
      // best effort
    }
  }

  async function start(): Promise<void> {
    if (stopTransport) return;
    if (config.server.transport === "http") {
      stopTransport = await startHttp(server, config);
    } else {
      stopTransport = await startStdio(server);
    }
    const onSignal = (signal: NodeJS.Signals) => {
      getLogger().info({ signal }, "signal received, stopping");
      void stop().then(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return {
    server,
    config,
    registeredTools: registry.list(),
    start,
    stop,
    __ctx: toolCtx,
  };
}

// Re-exports for library consumers.
export type { Config, ResolvedConfig } from "./config.js";
export type { Capability, Transport, LogLevel, ServerConfig, TimeoutConfig, CloudConfig } from "./config.js";
export type { ToolContext, ToolDefinition, ToolResponse, RegisteredTool } from "./registry/index.js";
export { TestRelicMcpError, AuthError, UpstreamError, NotFoundError, RateLimitedError, InvalidInputError, TimeoutError, CircuitOpenError } from "./errors.js";
export { version, name } from "./version.js";
