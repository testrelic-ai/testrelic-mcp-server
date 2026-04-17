import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { zodToJsonSchema } from "./zod-to-json.js";
import { getLogger } from "../logger.js";

/**
 * Elicitation helper: prompts the client's user for schema-driven input.
 * Gracefully degrades when a client doesn't implement elicitation — tools
 * should fall back to using whatever defaults they already have.
 */

export interface ElicitOptions {
  message: string;
  /** Zod schema describing the fields we want. */
  schema: z.ZodType;
}

export type ElicitResult =
  | { kind: "accepted"; content: Record<string, unknown> }
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "unsupported" };

export class Elicitor {
  constructor(private readonly server: McpServer) {}

  public async ask(opts: ElicitOptions): Promise<ElicitResult> {
    try {
      const sdkServer = (this.server as unknown as {
        server: { elicitInput: (req: unknown) => Promise<{ action: string; content?: Record<string, unknown> }> };
      }).server;
      if (!sdkServer?.elicitInput) return { kind: "unsupported" };
      const result = await sdkServer.elicitInput({
        message: opts.message,
        requestedSchema: zodToJsonSchema(opts.schema),
      });
      if (result.action === "accept" && result.content) return { kind: "accepted", content: result.content };
      if (result.action === "decline") return { kind: "declined" };
      if (result.action === "cancel") return { kind: "cancelled" };
      return { kind: "unsupported" };
    } catch (err) {
      getLogger().debug({ err }, "elicitation unavailable");
      return { kind: "unsupported" };
    }
  }
}
