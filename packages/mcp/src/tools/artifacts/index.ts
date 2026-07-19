import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ToolDefinition } from "../../registry/index.js";

/**
 * Artifacts capability — list, fetch, export, and save artifacts produced by
 * the Ask AI agent. Artifacts live in `ai_messages.artifacts` on the platform
 * and are addressable as `testrelic://artifacts/{id}` MCP resources.
 */

const ArtifactRow = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  createdAt: z.string(),
  conversationId: z.string(),
});

export const artifactsTools: ToolDefinition[] = [
  {
    name: "tr_artifacts_list",
    capability: "artifacts",
    title: "List artifacts",
    description:
      "Paginated list of artifacts. Filterable by conversationId, repoId, type (dashboard, report, test_plan, presentation, navigation_paths, session_workspace, etc.). Returns id, type, title, createdAt — fetch full payload with `tr_artifacts_get`.",
    inputSchema: {
      conversationId: z.string().optional(),
      repoId: z.string().optional(),
      type: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: {
      artifacts: z.array(ArtifactRow),
      nextCursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.listArtifacts({
        conversationId: input.conversationId as string | undefined,
        repoId: input.repoId as string | undefined,
        type: input.type as string | undefined,
        cursor: input.cursor as string | undefined,
        limit: input.limit as number | undefined,
      });
      const lines = [`## Artifacts (${r.artifacts.length})`, ""];
      for (const a of r.artifacts) {
        lines.push(`- **${a.id}** \`${a.type}\` — ${a.title} (conv: ${a.conversationId}, ${a.createdAt})`);
      }
      if (r.nextCursor) lines.push("", `_Next cursor: \`${r.nextCursor}\`_`);
      if (!r.artifacts.length) lines.push("_No artifacts match these filters._");
      return { text: lines.join("\n"), structured: r };
    },
  },
  {
    name: "tr_artifacts_get",
    capability: "artifacts",
    title: "Fetch one artifact",
    description: "Returns the full JSON payload of one artifact. The payload shape depends on `type` — see the platform's artifact renderers for the contract.",
    inputSchema: { id: z.string() },
    outputSchema: {
      id: z.string(),
      type: z.string(),
      title: z.string(),
      payload: z.record(z.unknown()),
      createdAt: z.string(),
    },
    handler: async (input, ctx) => {
      const r = await ctx.clients.cloud.getArtifact(String(input.id));
      const text = [
        `## ${r.title} (${r.type})`,
        "",
        `- **id:** ${r.id}`,
        `- **created:** ${r.createdAt}`,
        `- **resource:** testrelic://artifacts/${r.id}`,
      ].join("\n");
      return { text, structured: r };
    },
  },
  {
    name: "tr_artifacts_export",
    capability: "artifacts",
    title: "Export artifact to PNG or PDF",
    description:
      "Renders an artifact via the platform's headless export pipeline and returns a presigned S3 URL valid for ~1 hour. Use this for sharing or attaching to emails/PRs.",
    inputSchema: {
      id: z.string(),
      format: z.enum(["png", "pdf"]),
    },
    outputSchema: { url: z.string(), expiresAt: z.string() },
    handler: async (input, ctx) => {
      const id = String(input.id);
      const format = input.format as "png" | "pdf";
      const r = await ctx.clients.cloud.exportArtifact(id, format);
      const text = [
        `## Exported artifact ${id} → ${format.toUpperCase()}`,
        "",
        r.url,
        "",
        `_URL expires at ${r.expiresAt}._`,
      ].join("\n");
      return { text, structured: r };
    },
  },
  {
    name: "tr_artifacts_save_to_file",
    capability: "artifacts",
    title: "Save artifact JSON to local file",
    description:
      "Fetches an artifact and writes its JSON payload to a local file under the configured `outputDir`. Returns the absolute path so a downstream tool can hand it off (e.g. open in an editor).",
    inputSchema: {
      id: z.string(),
      filename: z.string().optional().describe("Override default filename (default: artifact-<id>.json)"),
    },
    outputSchema: { path: z.string(), bytes: z.number() },
    handler: async (input, ctx) => {
      const id = String(input.id);
      const r = await ctx.clients.cloud.getArtifact(id);
      const dir = resolve(ctx.config.outputDir);
      mkdirSync(dir, { recursive: true });
      const filename = (input.filename as string | undefined) ?? `artifact-${id}.json`;
      const path = join(dir, filename);
      const json = JSON.stringify(r, null, 2);
      writeFileSync(path, json, "utf-8");
      return { text: `Wrote ${json.length} bytes to ${path}.`, structured: { path, bytes: json.length } };
    },
  },
];
