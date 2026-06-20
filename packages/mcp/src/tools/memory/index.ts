import { z } from "zod";
import type { ToolDefinition } from "../../registry/index.js";
import { resolveProjectId } from "../../registry/project.js";

/**
 * Repo Memory capability — precision context delivery for any LLM.
 *
 * cloud-platform-app keeps a durable, repo-scoped "team memory" of
 * test-maintenance decisions, insights, and constraints (written from Ask AI
 * test-maintenance reviews, the Repo Detail → Memory tab, or these tools).
 * An external coding agent should call `tr_get_repo_memory` BEFORE reasoning
 * about a repo's tests so it respects established team decisions instead of
 * re-litigating them.
 *
 * Reads need only the PAT itself; `tr_save_repo_memory` additionally requires
 * the `mcp:memory` scope on the token.
 */

const MemoryEntry = z.object({
  id: z.string(),
  testId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  source: z.string(),
  status: z.string(),
  conversationId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  testMatched: z.boolean(),
  testTitle: z.string().nullable(),
});

const MemoryStats = z.object({
  total: z.number(),
  byCategory: z.record(z.number()),
  mappedToTests: z.number(),
  unmatchedTests: z.number(),
});

export const memoryTools: ToolDefinition[] = [
  {
    name: "tr_get_repo_memory",
    capability: "memory",
    title: "Get repo memory digest",
    description:
      "Compact LLM-ready digest of the repo's team memory: test-maintenance decisions, insights, maintenance notes, and constraints. Call this BEFORE proposing test modifications so you don't contradict established team decisions. Entries about deleted tests are marked '⚠ test spec no longer found'.",
    inputSchema: {
      project_id: z.string().optional().describe("Repo id or gitId; optional when a default repo is configured or only one repo exists"),
    },
    outputSchema: {
      repoId: z.string(),
      digest: z.string(),
      empty: z.boolean(),
    },
    handler: async (input, ctx) => {
      const repoId = resolveProjectId(ctx, input.project_id as string | undefined);
      const r = await ctx.clients.cloud.getRepoMemoryDigest(repoId);
      const text = r.empty
        ? "_No team memory recorded for this repository yet._"
        : `## Team memory for this repository\n\nTreat these as established team decisions — do not silently re-litigate them.\n\n${r.digest}`;
      return { text, structured: r };
    },
  },
  {
    name: "tr_list_repo_memories",
    capability: "memory",
    title: "List repo memory entries",
    description:
      "Raw, filterable list of repo memory entries with per-entry test-spec mapping (testMatched=false ⇒ the referenced test no longer exists; the memory may be stale) and aggregate stats (total, byCategory, mappedToTests, unmatchedTests).",
    inputSchema: {
      project_id: z.string().optional().describe("Repo id or gitId"),
      test_id: z.string().optional().describe("Filter to memories about one test (stable test id)"),
      category: z.string().optional().describe("decision | insight | maintenance | context"),
      status: z.string().optional().describe("active (default) | archived | all"),
      search: z.string().optional().describe("Free-text search over title/content/test"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    outputSchema: {
      memories: z.array(MemoryEntry),
      total: z.number(),
      stats: MemoryStats,
    },
    handler: async (input, ctx) => {
      const repoId = resolveProjectId(ctx, input.project_id as string | undefined);
      const r = await ctx.clients.cloud.listRepoMemories(repoId, {
        testId: input.test_id as string | undefined,
        category: input.category as string | undefined,
        status: input.status as string | undefined,
        search: input.search as string | undefined,
        limit: input.limit as number | undefined,
      });
      const lines = [
        `## Repo memory (${r.memories.length} shown, ${r.stats.total} active total)`,
        `Mapped to tests: ${r.stats.mappedToTests} · ⚠ Unmatched: ${r.stats.unmatchedTests}`,
        "",
      ];
      for (const m of r.memories) {
        const test = m.testId
          ? m.testMatched
            ? ` [test: ${m.testTitle ?? m.testId}]`
            : " [⚠ test spec no longer found]"
          : "";
        lines.push(`- **${m.title}** (${m.category}, ${m.source})${test} — ${m.content.slice(0, 160)}`);
      }
      return { text: lines.join("\n").trim(), structured: r };
    },
  },
  {
    name: "tr_save_repo_memory",
    capability: "memory",
    title: "Save a repo memory entry",
    description:
      "Persist a decision, insight, maintenance note, or constraint to the repo's team memory. Only save conclusions the user has explicitly agreed to. Requires the `mcp:memory` scope on the PAT (403 otherwise). Saved entries appear in the platform's Repo Detail → Memory tab and feed future AI context.",
    inputSchema: {
      project_id: z.string().optional().describe("Repo id or gitId"),
      title: z.string().describe("Short imperative title (max 300 chars)"),
      content: z.string().describe("Full decision/insight text including evidence and rationale"),
      category: z.string().optional().describe("decision | insight | maintenance | context (default insight)"),
      test_id: z.string().optional().describe("Stable test id when the memory is about one specific test"),
    },
    outputSchema: {
      saved: z.boolean(),
      memory: z.object({
        id: z.string(),
        title: z.string(),
        category: z.string(),
        testId: z.string().nullable(),
      }),
    },
    handler: async (input, ctx) => {
      const repoId = resolveProjectId(ctx, input.project_id as string | undefined);
      const r = await ctx.clients.cloud.createRepoMemory(repoId, {
        title: String(input.title),
        content: String(input.content),
        category: input.category as string | undefined,
        testId: input.test_id as string | undefined,
      });
      return {
        text: `✓ Saved repo memory "${r.memory.title}" [${r.memory.category}] (id: ${r.memory.id}).`,
        structured: {
          saved: true,
          memory: {
            id: r.memory.id,
            title: r.memory.title,
            category: r.memory.category,
            testId: r.memory.testId,
          },
        },
      };
    },
  },
];
