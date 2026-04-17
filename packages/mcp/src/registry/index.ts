import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { ResolvedConfig, Capability } from "../config.js";
import type { ClientBundle } from "../clients/index.js";
import type { BootstrapResponse } from "../clients/cloud.js";
import type { ContextEngine } from "../context/index.js";
import type { CacheManager } from "../cache/index.js";
import type { SamplingBridge } from "../sampling/bridge.js";
import type { Elicitor } from "../elicit/ask.js";
import { getLogger } from "../logger.js";
import { countObjectTokens, truncateToTokens } from "../telemetry/tokens.js";
import { metrics } from "../telemetry/metrics.js";
import { TestRelicMcpError } from "../errors.js";

/**
 * Capability-gated tool registry.
 *
 * Every tool declares its capability. `registerTools` filters by the
 * enabled capability set (with "core" always on) — this is the primary
 * token-reduction lever. A client with `--caps=creation` sees ~6 tools
 * instead of the full ~35, meaning the tool-schema prelude sent with
 * every request shrinks dramatically.
 */

export interface ToolContext {
  server: McpServer;
  config: ResolvedConfig;
  clients: ClientBundle;
  context: ContextEngine;
  cache: CacheManager;
  sampling: SamplingBridge;
  elicit: Elicitor;
  /**
   * One-time fetched at startup from `GET /api/v1/mcp/bootstrap`. Populated
   * best-effort — undefined if the call failed (e.g. no token, offline).
   * Tools that depend on repo discovery should guard on this.
   */
  bootstrap?: BootstrapResponse;
}

export interface ToolResponse {
  /** Human-readable summary (capped by tokenBudgetPerTool). */
  text: string;
  /** Machine-readable payload for MCP structured output. Typed loosely so handler authors can return concrete interfaces without indexable casts. */
  structured?: Record<string, unknown> | object;
  /** If this result is large, cache_key points to the full blob in L4. */
  cacheKey?: string;
}

export interface ToolDefinition<I extends z.ZodRawShape = z.ZodRawShape, O extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  capability: Capability;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema?: O;
  /** Alias names registered at the same time (used to deprecate v1 flat names). */
  aliases?: Array<{ name: string; description: string }>;
  /** Whether to treat this as deprecated (just metadata for listing). */
  deprecated?: boolean;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResponse>;
}

export interface RegisteredTool {
  name: string;
  capability: Capability;
  title: string;
  description: string;
  deprecated: boolean;
}

export class ToolRegistry {
  private readonly registered: RegisteredTool[] = [];

  public register<I extends z.ZodRawShape, O extends z.ZodRawShape>(
    ctx: ToolContext,
    def: ToolDefinition<I, O>,
  ): void {
    const isEnabled = ctx.config.capabilities.includes(def.capability);
    if (!isEnabled) return;

    const wrapped = async (rawInput: Record<string, unknown>) => {
      const start = Date.now();
      const inputTokens = countObjectTokens(rawInput);
      let outputTokens = 0;
      let errCode: string | undefined;
      try {
        const result = await def.handler(rawInput, ctx);
        const budget = ctx.config.tokenBudgetPerTool;
        const text = result.text.length > 0 ? truncateToTokens(result.text, budget) : "";
        const structured = (result.structured ?? {}) as Record<string, unknown>;
        outputTokens = countObjectTokens(text) + countObjectTokens(structured);
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      } catch (err) {
        if (err instanceof TestRelicMcpError) {
          errCode = err.code;
          return err.toToolError();
        }
        errCode = "INTERNAL";
        const message = err instanceof Error ? err.message : String(err);
        getLogger().error({ tool: def.name, err }, "tool handler threw");
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Internal error in ${def.name}: ${message}` }],
          structuredContent: { error: { code: "INTERNAL", message } },
        };
      } finally {
        const duration = Date.now() - start;
        metrics.record({
          ts: new Date().toISOString(),
          tool: def.name,
          capability: def.capability,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          duration_ms: duration,
          cache_hit: false,
          error_code: errCode,
        });
      }
    };

    ctx.server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
      },
      wrapped as unknown as Parameters<typeof ctx.server.registerTool>[2],
    );
    this.registered.push({
      name: def.name,
      capability: def.capability,
      title: def.title,
      description: def.description,
      deprecated: def.deprecated ?? false,
    });

    for (const alias of def.aliases ?? []) {
      ctx.server.registerTool(
        alias.name,
        {
          title: def.title,
          description: `[DEPRECATED — use ${def.name}] ${alias.description}`,
          inputSchema: def.inputSchema,
          outputSchema: def.outputSchema,
        },
        wrapped as unknown as Parameters<typeof ctx.server.registerTool>[2],
      );
      this.registered.push({
        name: alias.name,
        capability: def.capability,
        title: def.title,
        description: `[DEPRECATED] ${alias.description}`,
        deprecated: true,
      });
    }
  }

  public list(): RegisteredTool[] {
    return [...this.registered];
  }
}
