import { z } from "zod";
import { parsePatch } from "diff";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";
import type { CodeNode, DiffAnalysis, TestSelection } from "../../types/index.js";

/**
 * Impact capability — TDAD (Test-aware Diff Analysis Dependency) graph,
 * risk-based test selection, user-impact blast-radius scoring.
 */

export const impactTools: ToolDefinition[] = [
  {
    name: "tr_analyze_diff",
    capability: "impact",
    title: "Analyze a diff for test impact",
    description:
      "Parses a unified diff (or filename list) and returns the affected code nodes, the tests touching them, and an initial risk score based on Amplitude user counts on touched journeys.",
    inputSchema: {
      project_id: z.string(),
      unified_diff: z.string().optional(),
      files: z.array(z.string()).optional(),
    },
    outputSchema: {
      changed_files: z.array(z.string()),
      affected_node_count: z.number(),
      touched_test_count: z.number(),
      risk_score: z.number(),
      risk_level: z.enum(["low", "medium", "high", "critical"]),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const files = Array.isArray(input.files) ? (input.files as string[]) : diffFiles(input.unified_diff as string | undefined);
      if (!files.length) {
        return { text: "No files detected in diff or files list.", structured: { changed_files: [] } };
      }
      const [testMap, codeMap, journeys] = await Promise.all([
        ctx.context.coverage.load(project_id),
        ctx.clients.testrelic.getCodeMap(project_id).then((r) => r.data).catch(() => [] as CodeNode[]),
        ctx.context.journeys.top(project_id, 500),
      ]);

      const affected = codeMap.filter((n) => files.includes(n.file));
      const affectedIds = new Set(affected.map((n) => n.id));
      const touchedTests = testMap.filter((t) => t.code_node_ids.some((id) => affectedIds.has(id)));
      const touchedJourneyIds = new Set<string>();
      for (const t of touchedTests) for (const j of t.journey_ids) touchedJourneyIds.add(j);
      const touchedJourneys = journeys.filter((j) => touchedJourneyIds.has(j.id));
      const usersAtRisk = touchedJourneys.reduce((s, j) => s + (j.user_count ?? 0), 0);
      const totalUsers = journeys.reduce((s, j) => s + (j.user_count ?? 0), 0) || 1;
      const risk_score = Math.min(1, usersAtRisk / totalUsers + Math.min(0.3, files.length * 0.02));
      const risk_level: DiffAnalysis["risk_level"] =
        risk_score >= 0.7 ? "critical" : risk_score >= 0.4 ? "high" : risk_score >= 0.15 ? "medium" : "low";

      const analysis: DiffAnalysis = {
        changed_files: files,
        affected_nodes: affected,
        touched_tests: touchedTests.map((t) => ({ test_id: t.test_id, reason: "covers affected code node" })),
        touched_journeys: touchedJourneys.map((j) => ({ journey_id: j.id, user_count: j.user_count })),
        risk_score,
        risk_level,
      };

      const text = [
        `## Diff impact — ${project_id}`,
        "",
        `**Changed files:** ${files.length}`,
        `**Affected code nodes:** ${affected.length}`,
        `**Touched tests:** ${touchedTests.length}`,
        `**Touched journeys:** ${touchedJourneys.length} (${usersAtRisk.toLocaleString()} users)`,
        `**Risk:** ${risk_level.toUpperCase()} (${(risk_score * 100).toFixed(0)}%)`,
        "",
        "### Changed files",
        ...files.map((f) => `- \`${f}\``),
        "",
        touchedJourneys.length
          ? `### Journeys at risk\n${touchedJourneys.slice(0, 10).map((j) => `- \`${j.id}\` — ${j.user_count.toLocaleString()} users`).join("\n")}`
          : "",
        "",
        `Next step: call \`tr_select_tests\` with this \`project_id\` and \`files\` to get a MUST/SHOULD/OPTIONAL test list.`,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        text,
        structured: {
          changed_files: files,
          affected_node_count: affected.length,
          touched_test_count: touchedTests.length,
          risk_score,
          risk_level,
          analysis,
        },
      };
    },
  },
  {
    name: "tr_select_tests",
    capability: "impact",
    title: "Select tests for a diff",
    description:
      "Ranks tests into MUST / SHOULD / OPTIONAL buckets for a given diff. MUST = directly touches changed code. SHOULD = shares journey with a touched test. OPTIONAL = broader safety net.",
    inputSchema: {
      project_id: z.string(),
      files: z.array(z.string()).optional(),
      unified_diff: z.string().optional(),
      max_total: z.number().int().optional().default(100),
    },
    outputSchema: {
      must: z.array(z.string()),
      should: z.array(z.string()),
      optional: z.array(z.string()),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const files = Array.isArray(input.files) ? (input.files as string[]) : diffFiles(input.unified_diff as string | undefined);
      const maxTotal = (input.max_total as number | undefined) ?? 100;
      const [testMap, codeMap] = await Promise.all([
        ctx.context.coverage.load(project_id),
        ctx.clients.testrelic.getCodeMap(project_id).then((r) => r.data).catch(() => [] as CodeNode[]),
      ]);
      const affectedIds = new Set(codeMap.filter((n) => files.includes(n.file)).map((n) => n.id));
      const must = testMap.filter((t) => t.code_node_ids.some((id) => affectedIds.has(id)));
      const mustIds = new Set(must.map((t) => t.test_id));
      const mustJourneys = new Set<string>();
      for (const t of must) for (const j of t.journey_ids) mustJourneys.add(j);

      const should = testMap.filter(
        (t) => !mustIds.has(t.test_id) && t.journey_ids.some((j) => mustJourneys.has(j)),
      );
      const shouldIds = new Set(should.map((t) => t.test_id));

      const optional = testMap
        .filter((t) => !mustIds.has(t.test_id) && !shouldIds.has(t.test_id))
        .slice(0, Math.max(0, maxTotal - must.length - should.length));

      const selection: TestSelection = {
        must: must.map((t) => t.test_id),
        should: should.map((t) => t.test_id),
        optional: optional.map((t) => t.test_id),
        reasoning: Object.fromEntries([
          ...must.map((t) => [t.test_id, `MUST — touches code node in ${files.length} changed file(s)`] as const),
          ...should.map((t) => [t.test_id, `SHOULD — shares a journey with a MUST test`] as const),
          ...optional.map((t) => [t.test_id, `OPTIONAL — broad safety net`] as const),
        ]),
      };

      const text = [
        `## Test selection — ${project_id}`,
        "",
        `**MUST run (${selection.must.length}):**`,
        ...selection.must.slice(0, 20).map((id) => `- \`${id}\``),
        selection.must.length > 20 ? `_(+${selection.must.length - 20} more)_` : "",
        "",
        `**SHOULD run (${selection.should.length}):**`,
        ...selection.should.slice(0, 20).map((id) => `- \`${id}\``),
        selection.should.length > 20 ? `_(+${selection.should.length - 20} more)_` : "",
        "",
        `**OPTIONAL (${selection.optional.length})** — run if budget allows.`,
      ]
        .filter(Boolean)
        .join("\n");

      return { text, structured: selection };
    },
  },
  {
    name: "tr_risk_score",
    capability: "impact",
    title: "Risk score for a diff",
    description:
      "Lightweight blast-radius estimate using only Amplitude user counts on journeys whose tests cover the changed files. Faster than tr_analyze_diff when the agent only needs a go/no-go signal.",
    inputSchema: {
      project_id: z.string(),
      files: z.array(z.string()).optional(),
      unified_diff: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const files = Array.isArray(input.files) ? (input.files as string[]) : diffFiles(input.unified_diff as string | undefined);
      if (!files.length) return { text: "No files detected.", structured: { risk_score: 0 } };
      const [testMap, codeMap, journeys] = await Promise.all([
        ctx.context.coverage.load(project_id),
        ctx.clients.testrelic.getCodeMap(project_id).then((r) => r.data).catch(() => [] as CodeNode[]),
        ctx.context.journeys.top(project_id, 500),
      ]);
      const affectedIds = new Set(codeMap.filter((n) => files.includes(n.file)).map((n) => n.id));
      const touchedJourneyIds = new Set<string>();
      for (const t of testMap) if (t.code_node_ids.some((id) => affectedIds.has(id))) for (const j of t.journey_ids) touchedJourneyIds.add(j);
      const touchedUsers = journeys.filter((j) => touchedJourneyIds.has(j.id)).reduce((s, j) => s + (j.user_count ?? 0), 0);
      const totalUsers = journeys.reduce((s, j) => s + (j.user_count ?? 0), 0) || 1;
      const score = Math.min(1, touchedUsers / totalUsers);
      const level = score >= 0.7 ? "critical" : score >= 0.4 ? "high" : score >= 0.15 ? "medium" : "low";
      return {
        text: `**Risk:** ${level.toUpperCase()} (${(score * 100).toFixed(1)}% of tracked users on journeys touching these files — ${touchedUsers.toLocaleString()} / ${totalUsers.toLocaleString()})`,
        structured: { risk_score: score, risk_level: level, touched_users: touchedUsers, total_users: totalUsers },
      };
    },
  },
];

function diffFiles(diff?: string): string[] {
  if (!diff) return [];
  try {
    const patches = parsePatch(diff);
    const files = new Set<string>();
    for (const p of patches) {
      if (p.newFileName && p.newFileName !== "/dev/null") files.add(stripPrefix(p.newFileName));
      else if (p.oldFileName && p.oldFileName !== "/dev/null") files.add(stripPrefix(p.oldFileName));
    }
    return Array.from(files);
  } catch {
    return [];
  }
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "").replace(/^--- /, "").replace(/^\+\+\+ /, "").trim();
}

export function registerImpactTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of impactTools) register(t);
}
