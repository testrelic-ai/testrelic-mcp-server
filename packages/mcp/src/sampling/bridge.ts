import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLogger } from "../logger.js";

/**
 * Sampling bridge: wraps `server.server.createMessage` so tools can ask the
 * client's LLM to generate text without the server needing its own LLM key.
 *
 * Falls back to a deterministic template when the client doesn't support
 * sampling — preserves the "works offline" guarantee.
 */

export interface SamplingOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  modelPreferences?: {
    hints?: Array<{ name: string }>;
    intelligencePriority?: number;
    costPriority?: number;
    speedPriority?: number;
  };
  stopSequences?: string[];
}

export interface SamplingResult {
  text: string;
  model?: string;
  stopReason?: string;
  /** True when we fell back to a local template because sampling failed. */
  fallback: boolean;
}

export class SamplingBridge {
  constructor(private readonly server: McpServer) {}

  public async createMessage(prompt: string, opts: SamplingOptions = {}): Promise<SamplingResult> {
    try {
      const sdkServer = (this.server as unknown as { server: { createMessage: (req: unknown) => Promise<{ content: { type: string; text?: string }; model?: string; stopReason?: string }> } }).server;
      if (!sdkServer?.createMessage) throw new Error("sampling not supported by client");

      const result = await sdkServer.createMessage({
        messages: [
          {
            role: "user",
            content: { type: "text", text: prompt },
          },
        ],
        systemPrompt: opts.systemPrompt,
        maxTokens: opts.maxTokens ?? 2_000,
        temperature: opts.temperature ?? 0.3,
        modelPreferences: opts.modelPreferences,
        stopSequences: opts.stopSequences,
      });

      const text = result.content?.type === "text" ? result.content.text ?? "" : "";
      return {
        text,
        model: result.model,
        stopReason: result.stopReason,
        fallback: false,
      };
    } catch (err) {
      getLogger().debug({ err }, "sampling unavailable — using local fallback");
      return { text: "", fallback: true };
    }
  }
}
