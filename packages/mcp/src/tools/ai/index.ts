import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";

/**
 * Ask AI capability — exposes cloud-platform-app's Ask AI surface to external
 * MCP clients. The platform owns the LLM key, the agent loop, and the prompt
 * templates. This file is a thin schema layer over `/api/v1/mcp/ai/*`.
 *
 * Two strategies for the long tail of platform tools:
 *  - Granular: one `tr_*` tool per high-value artifact generator (8 below).
 *  - Universal: `tr_ai_execute` for any platform tool by name (40+ on the
 *    platform). Keeps the MCP tool-schema prelude small while still allowing
 *    the agent to call any tool when needed.
 */

const ArtifactSummary = z.object({
  id: z.string().optional(),
  type: z.string(),
  payload: z.record(z.unknown()),
});

const ConversationSummary = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number(),
});

const Message = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.string(),
  artifacts: z.array(z.record(z.unknown())).optional(),
});

function artifactGenerator(
  name: string,
  platformTool: string,
  artifactType: string,
  title: string,
  description: string,
): ToolDefinition {
  return {
    name,
    capability: "ai",
    title,
    description,
    inputSchema: {
      input: z.record(z.unknown()).describe(
        "Tool-specific input. Refer to the platform's input_schema via `tr_ai_list_tools` for the exact shape.",
      ),
    },
    outputSchema: {
      artifact: ArtifactSummary,
      result: z.record(z.unknown()),
    },
    handler: async (input, ctx) => {
      const args = (input.input ?? {}) as Record<string, unknown>;
      const r = await ctx.clients.cloud.executeAiTool(platformTool, args);
      const artifact = r.artifact ?? { type: artifactType, payload: r.result };
      const summary = artifact.id ? ` (id: ${artifact.id})` : "";
      const text = [
        `## ${title}${summary}`,
        "",
        `Artifact type: \`${artifact.type}\``,
        artifact.id ? `Resource: \`testrelic://artifacts/${artifact.id}\`` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structured: { artifact, result: r.result } };
    },
  };
}

export const aiTools: ToolDefinition[] = [
  {
    name: "tr_ai_list_tools",
    capability: "ai",
    title: "List Ask-AI tools",
    description:
      "Catalog of every AI tool the platform exposes. Use this before `tr_ai_execute` to discover available tools and their input schemas. Output is paginated-friendly (one entry per tool).",
    inputSchema: {},
    outputSchema: {
      catalog: z.array(
        z.object({
          name: z.string(),
          category: z.string(),
          description: z.string(),
          output: z.enum(["text", "artifact"]),
          artifactType: z.string().optional(),
          inputSchema: z.record(z.unknown()),
        }),
      ),
    },
    handler: async (_input, ctx) => {
      const r = await ctx.clients.cloud.listAiTools();
      const lines = [`## Ask-AI tools (${r.catalog.length})`, ""];
      const byCategory = new Map<string, typeof r.catalog>();
      for (const t of r.catalog) {
        const arr = byCategory.get(t.category) ?? [];
        arr.push(t);
        byCategory.set(t.category, arr);
      }
      for (const [cat, tools] of byCategory) {
        lines.push(`### ${cat}`);
        for (const t of tools) {
          const out = t.output === "artifact" ? `→ ${t.artifactType ?? "artifact"}` : "→ text";
          lines.push(`- **${t.name}** ${out} — ${t.description.slice(0, 120)}`);
        }
        lines.push("");
      }
      return { text: lines.join("\n").trim(), structured: r };
    },
  },
  {
    name: "tr_ai_execute",
    capability: "ai",
    title: "Execute an Ask-AI tool",
    description:
      "Invokes any AI tool by name. Body: { tool_name, input }. Returns { result, artifact? }. When the tool produces an artifact (dashboard, report, test_plan, presentation, navigation_paths, session_workspace), the artifact is also addressable as `testrelic://artifacts/{id}` after the call.",
    inputSchema: {
      tool_name: z.string().describe("Tool name from `tr_ai_list_tools` (e.g. query_test_runs, query_jira_issues)"),
      input: z.record(z.unknown()).describe("Tool-specific input"),
    },
    outputSchema: {
      result: z.record(z.unknown()),
      artifact: ArtifactSummary.optional(),
    },
    handler: async (input, ctx) => {
      const name = String(input.tool_name);
      const args = (input.input ?? {}) as Record<string, unknown>;
      const r = await ctx.clients.cloud.executeAiTool(name, args);
      const text = r.artifact
        ? `✓ ${name} produced ${r.artifact.type}${r.artifact.id ? ` (testrelic://artifacts/${r.artifact.id})` : ""}.`
        : `✓ ${name} returned text result.`;
      return { text, structured: r };
    },
  },
  {
    name: "tr_ask_ai",
    capability: "ai",
    title: "Ask AI (single turn)",
    description:
      "Runs the Ask AI agent loop for a single user message. The platform handles LLM calls, tool orchestration, and artifact generation. Returns the assistant's response plus any artifacts it produced. Pass `conversationId` to continue an existing thread, or omit to start a new one.",
    inputSchema: {
      message: z.string().describe("User message"),
      conversationId: z.string().optional(),
      repoId: z.string().optional().describe("Repo context for grounding"),
      runId: z.string().optional().describe("Specific run to focus on"),
      maxToolRounds: z.number().int().min(1).max(15).optional(),
    },
    outputSchema: {
      conversationId: z.string(),
      messages: z.array(Message),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
    },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.runAgent({
        messages: [{ role: "user", content: String(input.message) }],
        conversationId: input.conversationId as string | undefined,
        repoId: input.repoId as string | undefined,
        runId: input.runId as string | undefined,
        maxToolRounds: input.maxToolRounds as number | undefined,
      });
      const assistant = r.messages.filter((m) => m.role === "assistant").pop();
      const text = assistant?.content ?? "_(no assistant reply)_";
      return { text, structured: r };
    },
  },
  {
    name: "tr_ai_list_conversations",
    capability: "ai",
    title: "List Ask-AI conversations",
    description: "Paginated list of conversations for the authenticated user. Use this to find a conversationId to continue.",
    inputSchema: {
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: {
      conversations: z.array(ConversationSummary),
      nextCursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.listConversations({
        cursor: input.cursor as string | undefined,
        limit: input.limit as number | undefined,
      });
      const lines = [`## Conversations (${r.conversations.length})`, ""];
      for (const c of r.conversations) {
        lines.push(`- **${c.id}** — ${c.title} (${c.messageCount} msgs, updated ${c.updatedAt})`);
      }
      if (r.nextCursor) lines.push("", `_Next cursor: \`${r.nextCursor}\`_`);
      return { text: lines.join("\n"), structured: r };
    },
  },
  {
    name: "tr_ai_get_conversation",
    capability: "ai",
    title: "Get one Ask-AI conversation",
    description: "Returns the full message history for one conversation, including artifact references on assistant turns.",
    inputSchema: { id: z.string() },
    outputSchema: {
      id: z.string(),
      title: z.string(),
      messages: z.array(Message),
    },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.getConversation(String(input.id));
      const lines = [`## ${r.title}`, ""];
      for (const m of r.messages) {
        lines.push(`### ${m.role}`);
        lines.push(m.content);
        if (m.artifacts?.length) lines.push(`_(${m.artifacts.length} artifact${m.artifacts.length === 1 ? "" : "s"} attached)_`);
        lines.push("");
      }
      return { text: lines.join("\n").trim(), structured: r };
    },
  },
  {
    name: "tr_ai_new_conversation",
    capability: "ai",
    title: "Create a new conversation",
    description: "Creates an empty conversation. Use the returned `id` as `conversationId` in subsequent `tr_ask_ai` calls.",
    inputSchema: {
      title: z.string().optional(),
      repoId: z.string().optional(),
    },
    outputSchema: { id: z.string(), title: z.string() },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.createConversation({
        title: input.title as string | undefined,
        repoId: input.repoId as string | undefined,
      });
      return { text: `Created conversation ${r.id}: "${r.title}".`, structured: r };
    },
  },
  {
    name: "tr_ai_delete_conversation",
    capability: "ai",
    title: "Delete an Ask-AI conversation",
    description: "Permanently deletes a conversation and its messages.",
    inputSchema: { id: z.string() },
    outputSchema: { ok: z.boolean() },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.deleteConversation(String(input.id));
      return { text: `Deleted conversation ${input.id}.`, structured: r };
    },
  },
  {
    name: "tr_ai_usage",
    capability: "ai",
    title: "Ask-AI token usage",
    description: "Current month's token usage vs the org's monthly budget. Use this to plan large Ask-AI workflows.",
    inputSchema: {},
    outputSchema: {
      monthlyTokenUsage: z.number(),
      monthlyTokenBudget: z.number(),
      monthlyRequestCount: z.number(),
      overLimit: z.boolean(),
    },
    handler: async (_input, ctx) => {
      const r = await ctx.clients.cloud.getAiUsage();
      const pct = r.monthlyTokenBudget > 0 ? ((r.monthlyTokenUsage / r.monthlyTokenBudget) * 100).toFixed(1) : "n/a";
      const text = [
        `## Ask-AI usage (current month)`,
        ``,
        `- **Used:** ${r.monthlyTokenUsage.toLocaleString()} tokens (${pct}% of budget)`,
        `- **Budget:** ${r.monthlyTokenBudget.toLocaleString()} tokens`,
        `- **Requests:** ${r.monthlyRequestCount}`,
        `- **Over limit:** ${r.overLimit ? "yes" : "no"}`,
      ].join("\n");
      return { text, structured: r };
    },
  },
  // ── Granular artifact generators ─────────────────────────────────────
  artifactGenerator(
    "tr_generate_dashboard",
    "generate_dashboard",
    "dashboard",
    "Generate a dashboard",
    "Asks the platform to produce a dashboard artifact (widget array). Input shape mirrors the platform's `generate_dashboard` tool — see `tr_ai_list_tools` for the exact schema.",
  ),
  artifactGenerator(
    "tr_generate_report",
    "generate_report",
    "report",
    "Generate a report",
    "Produces a markdown report artifact with structured sections. Input matches the platform's `generate_report` tool.",
  ),
  artifactGenerator(
    "tr_generate_test_plan",
    "generate_test_plan",
    "test_plan",
    "Generate a test plan",
    "Produces a test_plan artifact suitable for export to PDF. Input matches the platform's `generate_test_plan` tool.",
  ),
  artifactGenerator(
    "tr_generate_presentation",
    "generate_presentation",
    "presentation",
    "Generate a presentation",
    "Produces a slide-deck presentation artifact. Input matches the platform's `generate_presentation` tool.",
  ),
  artifactGenerator(
    "tr_generate_navigation_paths",
    "generate_navigation_paths",
    "navigation_paths",
    "Generate a navigation paths diagram",
    "Produces a navigation_paths artifact (journey graph). Input matches the platform's `generate_navigation_paths` tool.",
  ),
];
