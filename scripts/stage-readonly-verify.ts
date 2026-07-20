/**
 * Read-only verification of the 3.3.1 build against a LIVE cloud (stage/prod).
 *
 * Boots the server in-process against the real platform API with a real PAT,
 * then drives only NON-MUTATING tools with inputs chained from live bootstrap
 * data. Every mutating tool is excluded by an explicit allow-list, so nothing
 * in the target environment changes.
 *
 * Usage:
 *   TESTRELIC_CLOUD_URL=https://stage.testrelic.ai/api/v1 \
 *   TESTRELIC_MCP_TOKEN=$(cat ~/.testrelic/token.stage) \
 *   npx tsx scripts/stage-readonly-verify.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type TestRelicServer } from "../packages/mcp/src/index.js";
import { ALL_TOOLS } from "../packages/mcp/src/tools/index.js";
import type { Capability } from "../packages/mcp/src/config.js";

// Only these capabilities are enabled — no marketplace/apps connect/execute.
const CAPS: Capability[] = ["core", "coverage", "triage", "signals", "impact", "devtools", "ai", "memory"];

// Hard allow-list: a tool runs ONLY if named here. Anything that writes,
// connects, disconnects, dismisses, or files is deliberately absent.
const READONLY = new Set<string>([
  "tr_list_repos", "tr_describe_repo", "tr_integration_status", "tr_recent_runs",
  "tr_get_config", "tr_health", "tr_fetch_cached",
  "tr_user_journeys", "tr_test_map", "tr_coverage_gaps", "tr_coverage_report",
  "tr_flaky_audit", "tr_compare_runs", "tr_search_failures", "tr_ai_rca", "tr_diagnose_run",
  "tr_user_impact", "tr_production_signal", "tr_affected_sessions",
  "tr_project_trends", "tr_active_alerts", "tr_cache_stats",
  "tr_ai_list_tools", "tr_ai_list_conversations", "tr_ai_usage",
  "tr_get_repo_memory", "tr_list_repo_memories",
]);

interface Row { tool: string; ok: boolean; detail: string }
const rows: Row[] = [];

async function call(
  srv: TestRelicServer, name: string, input: Record<string, unknown>,
): Promise<{ text: string; structured?: unknown } | undefined> {
  if (!READONLY.has(name)) { rows.push({ tool: name, ok: false, detail: "NOT in read-only allow-list — refused" }); return; }
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) { rows.push({ tool: name, ok: false, detail: "not registered" }); return; }
  try {
    const r = (await tool.handler(input, srv.__ctx)) as { text: string; structured?: unknown; isError?: boolean };
    if (r.isError) { rows.push({ tool: name, ok: false, detail: `isError: ${(r.text ?? "").slice(0, 90)}` }); return r; }
    rows.push({ tool: name, ok: true, detail: (r.text ?? "").split("\n")[0]!.slice(0, 80) });
    return r;
  } catch (e) { rows.push({ tool: name, ok: false, detail: (e as Error).message.slice(0, 110) }); }
}
const S = <T,>(r: { structured?: unknown } | undefined): T => (r?.structured ?? {}) as T;

async function main(): Promise<number> {
  const cloudUrl = process.env.TESTRELIC_CLOUD_URL;
  const token = process.env.TESTRELIC_MCP_TOKEN;
  if (!cloudUrl || !token) { console.error("set TESTRELIC_CLOUD_URL and TESTRELIC_MCP_TOKEN"); return 2; }
  console.log(`Read-only verify against ${cloudUrl}\n`);

  const id = randomUUID().slice(0, 8);
  const srv = await createServer({
    capabilities: CAPS, mockMode: false, logLevel: "warn",
    isolated: true, saveSession: false,
    cloud: { baseUrl: cloudUrl, token },
    outputDir: join(tmpdir(), `tr-stage-out-${id}`), cacheDir: join(tmpdir(), `tr-stage-cache-${id}`),
  });

  try {
    console.log(`bootstrap: ${srv.__ctx.bootstrap ? "loaded" : "MISSING (401?)"}, `
      + `${srv.__ctx.bootstrap?.repos?.length ?? 0} repos, ${srv.registeredTools.length} tools registered\n`);

    const repos = await call(srv, "tr_list_repos", { limit: 5 });
    const repoId = S<{ repos?: Array<{ repo_id: string }> }>(repos).repos?.[0]?.repo_id;
    const pid = repoId ?? srv.__ctx.bootstrap?.repos?.[0]?.id;

    await call(srv, "tr_health", {});
    await call(srv, "tr_get_config", {});
    await call(srv, "tr_integration_status", { type: "jira" });
    if (pid) await call(srv, "tr_describe_repo", { repo_id: pid });

    const runs = await call(srv, "tr_recent_runs", { project_id: pid, limit: 10 });
    const runList = S<{ runs?: Array<{ run_id: string; status: string }> }>(runs).runs ?? [];
    const failed = runList.find((r) => r.status === "failed")?.run_id;
    const anyRun = runList[0]?.run_id;
    const twoRuns = runList.slice(0, 2).map((r) => r.run_id);

    // THE fix under real load: live 0–100 flakiness scores, the exact crash path.
    await call(srv, "tr_flaky_audit", { project_id: pid });

    if (pid) {
      await call(srv, "tr_coverage_report", { project_id: pid });
      await call(srv, "tr_coverage_gaps", { project_id: pid, limit: 5 });
      await call(srv, "tr_user_journeys", { project_id: pid, limit: 5 });
      await call(srv, "tr_project_trends", { project_id: pid, days: 7 });
    }
    await call(srv, "tr_search_failures", { query: "timeout" });
    if (failed) {
      await call(srv, "tr_diagnose_run", { run_id: failed });
      await call(srv, "tr_ai_rca", { run_id: failed });
      await call(srv, "tr_user_impact", { run_id: failed });
      await call(srv, "tr_affected_sessions", { run_id: failed, limit: 5 });
    }
    if (twoRuns.length === 2 && twoRuns[0] !== twoRuns[1]) {
      await call(srv, "tr_compare_runs", { run_id_a: twoRuns[0], run_id_b: twoRuns[1] });
    }
    void anyRun;

    await call(srv, "tr_active_alerts", {});
    await call(srv, "tr_cache_stats", {});
    await call(srv, "tr_ai_list_tools", {});
    await call(srv, "tr_ai_list_conversations", {});
    await call(srv, "tr_ai_usage", {});
    if (pid) {
      await call(srv, "tr_get_repo_memory", { project_id: pid });
      await call(srv, "tr_list_repo_memories", { project_id: pid, limit: 5 });
    }
  } finally {
    await srv.stop().catch(() => undefined);
  }

  for (const r of rows) process.stdout.write(`[${r.ok ? "PASS" : "FAIL"}] ${r.tool.padEnd(24)} ${r.detail}\n`);
  const failed = rows.filter((r) => !r.ok);
  process.stdout.write(`\n${rows.length - failed.length}/${rows.length} read-only tools passed against ${cloudUrl}\n`);
  return failed.length === 0 ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(2); });
