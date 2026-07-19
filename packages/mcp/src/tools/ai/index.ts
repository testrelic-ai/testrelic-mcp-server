import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";

/**
 * Ask AI capability — exposes cloud-platform-app's Ask AI surface to external
 * MCP clients. The platform owns the LLM key, the agent loop, and the prompt
 * templates. This file is a thin schema layer over `/api/v1/mcp/ai/*`.
 *
 * One strategy for the long tail of platform tools: `tr_ai_execute` invokes any
 * platform tool by name (40+ on the platform). Until 3.3.0 there was also a
 * "granular" set of five `tr_generate_*` wrappers, but they resolved to the same
 * `executeAiTool` call with a hardcoded name and an opaque input schema, so they
 * cost five prelude slots for no added type safety. Keeping the prelude small is
 * the whole point of this layer.
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
      "Invokes any AI tool by name. Body: { tool_name, input }. Returns { result, artifact? }. When the tool produces an artifact (dashboard, report, test_plan, presentation, navigation_paths, session_workspace), the artifact is also addressable as `testrelic://artifacts/{id}` after the call. This is also how you generate artifacts: pass tool_name `generate_dashboard`, `generate_report`, `generate_test_plan`, `generate_presentation`, or `generate_navigation_paths` (these replaced the removed `tr_generate_*` tools).",
    inputSchema: {
      tool_name: z.string().describe("Tool name from `tr_ai_list_tools` (e.g. query_test_runs, query_jira_issues, generate_report)"),
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
  // The five `tr_generate_*` artifact generators were removed in 3.3.0. Each
  // was a `artifactGenerator()` wrapper whose handler called
  // `cloud.executeAiTool(<literal>, args)` — exactly what `tr_ai_execute` does
  // with a runtime `tool_name`. Their inputSchema was an opaque
  // `z.record(z.unknown())` whose own description told the caller to read
  // `tr_ai_list_tools` for the real shape, so they carried no schema value over
  // the generic tool while costing five slots in every client's prelude.
  //
  // Migration: tr_generate_dashboard        -> tr_ai_execute { tool_name: "generate_dashboard" }
  //            tr_generate_report           -> tr_ai_execute { tool_name: "generate_report" }
  //            tr_generate_test_plan        -> tr_ai_execute { tool_name: "generate_test_plan" }
  //            tr_generate_presentation     -> tr_ai_execute { tool_name: "generate_presentation" }
  //            tr_generate_navigation_paths -> tr_ai_execute { tool_name: "generate_navigation_paths" }
];
