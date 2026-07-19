/**
 * Full-coverage dogfood walk — every registered tool, chained real inputs.
 *
 * Unlike smoke-e2e.ts (a canonical happy-path sequence), this drives EVERY
 * tool in ALL_TOOLS against the mock server, feeding outputs into inputs
 * (repo -> runs -> diagnose -> rca -> fix ...) the way an agent actually
 * would. It fails if:
 *   - any tool errors or returns isError,
 *   - any registered tool was never exercised (completeness check),
 *   - the registered-surface counts drift (66 canonical / +14 legacy),
 *   - the truncation-recovery round-trip cannot redeem a cacheKey from a
 *     capability set without `coverage` (the 3.3.0 bug fix).
 *
 * Usage:  npx tsx scripts/dogfood-all.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type TestRelicServer } from "../packages/mcp/src/index.js";
import { ALL_TOOLS } from "../packages/mcp/src/tools/index.js";
import type { Capability } from "../packages/mcp/src/config.js";

const ALL_CAPS: Capability[] = [
  "core", "coverage", "creation", "healing", "impact", "triage", "signals",
  "devtools", "ai", "marketplace", "apps", "artifacts", "memory",
];

interface Row {
  tool: string;
  ok: boolean;
  detail: string;
}

const rows: Row[] = [];
const exercised = new Set<string>();

async function callTool(
  srv: TestRelicServer,
  name: string,
  input: Record<string, unknown>,
  check?: (r: { text: string; structured?: unknown }) => string | undefined,
): Promise<{ text: string; structured?: unknown } | undefined> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) {
    rows.push({ tool: name, ok: false, detail: "NOT IN ALL_TOOLS" });
    return undefined;
  }
  exercised.add(name);
  try {
    const r = (await tool.handler(input, srv.__ctx)) as {
      text: string;
      structured?: unknown;
      isError?: boolean;
    };
    if (r.isError) {
      rows.push({ tool: name, ok: false, detail: `isError: ${r.text?.slice(0, 100)}` });
      return undefined;
    }
    if (!r.text || !r.text.trim()) {
      rows.push({ tool: name, ok: false, detail: "empty text response" });
      return r;
    }
    const complaint = check?.(r);
    if (complaint) {
      rows.push({ tool: name, ok: false, detail: `shape: ${complaint}` });
      return r;
    }
    rows.push({ tool: name, ok: true, detail: r.text.split("\n")[0]!.slice(0, 76) });
    return r;
  } catch (err) {
    rows.push({ tool: name, ok: false, detail: (err as Error).message.slice(0, 120) });
    return undefined;
  }
}

function s<T>(r: { structured?: unknown } | undefined): T {
  return (r?.structured ?? {}) as T;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.unref();
    sock.on("error", reject);
    sock.listen(0, "127.0.0.1", () => {
      const addr = sock.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        sock.close(() => resolve(port));
      } else reject(new Error("could not pick a free port"));
    });
  });
}

async function startMock(): Promise<{ child: ChildProcess; url: string }> {
  const port = await findFreePort();
  const url = `http://localhost:${port}`;
  const child = spawn("npx", ["tsx", "mock-server/index.ts"], {
    env: { ...process.env, MOCK_SERVER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (/Running on http:/.test(chunk.toString("utf-8"))) resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`mock exited early (${code})`)));
    setTimeout(() => reject(new Error("mock did not start in 45s")), 45_000).unref();
  });
  return { child, url };
}

async function boot(mockUrl: string, overrides: Record<string, unknown> = {}): Promise<TestRelicServer> {
  const id = randomUUID().slice(0, 8);
  return createServer({
    capabilities: ALL_CAPS,
    mockMode: true,
    mockServerUrl: mockUrl,
    logLevel: "warn",
    isolated: true,
    saveSession: false,
    outputDir: join(tmpdir(), `tr-dogfood-out-${id}`),
    cacheDir: join(tmpdir(), `tr-dogfood-cache-${id}`),
    ...overrides,
  });
}

async function main(): Promise<number> {
  const { child: mock, url: mockUrl } = await startMock();
  const srv = await boot(mockUrl);
  const hard: string[] = [];

  try {
    // ── Surface counts ──────────────────────────────────────────────────
    const names = srv.registeredTools.map((t) => t.name);
    if (names.length !== 66) hard.push(`expected 66 registered names, got ${names.length}`);
    if (names.some((n) => n.startsWith("testrelic_"))) {
      hard.push("legacy testrelic_* names registered without the flag");
    }

    // ── core ────────────────────────────────────────────────────────────
    const repos = await callTool(srv, "tr_list_repos", {}, (r) =>
      Array.isArray(s<{ repos?: unknown[] }>(r).repos) ? undefined : "no repos[]",
    );
    // The structured shape is { repo_id, repo_name, git_id } — NOT `id`.
    const repoId = s<{ repos?: Array<{ repo_id: string }> }>(repos).repos?.[0]?.repo_id;

    await callTool(srv, "tr_describe_repo", { repo_id: repoId ?? "repo-1" });
    await callTool(srv, "tr_integration_status", { type: "jira" });

    const runs = await callTool(srv, "tr_recent_runs", { limit: 5 }, (r) =>
      Array.isArray(s<{ runs?: unknown[] }>(r).runs) ? undefined : "no runs[]",
    );
    const runList = s<{ runs?: Array<{ run_id: string; status: string }> }>(runs).runs ?? [];
    const runId = runList[0]?.run_id ?? "run-001";
    const failedRun = runList.find((r) => r.status === "failed")?.run_id ?? runId;
    const secondRun = runList[1]?.run_id ?? runId;
    const projectId = repoId ?? "repo-1";

    await callTool(srv, "tr_get_config", {});
    await callTool(srv, "tr_health", {});

    // ── coverage (also produces the cacheKey used by tr_fetch_cached) ───
    const journeys = await callTool(srv, "tr_user_journeys", { project_id: projectId, limit: 5 });
    const journeyId = s<{ journeys?: Array<{ id: string }> }>(journeys).journeys?.[0]?.id;

    const testMap = await callTool(srv, "tr_test_map", { project_id: projectId });
    const mapCacheKey = s<{ cache_key?: string }>(testMap).cache_key;
    const testId =
      s<{ entries?: Array<{ test_id: string; test_name: string }> }>(testMap).entries?.[0]?.test_id ??
      "test-001";
    const testName =
      s<{ entries?: Array<{ test_id: string; test_name: string }> }>(testMap).entries?.[0]?.test_name ??
      "checkout flow";

    await callTool(srv, "tr_coverage_gaps", { project_id: projectId, limit: 5 });
    await callTool(srv, "tr_coverage_report", { project_id: projectId }, (r) => {
      const rep = s<{ user_coverage?: number; test_coverage?: number }>(r);
      return typeof rep.user_coverage === "number" && typeof rep.test_coverage === "number"
        ? undefined
        : "coverage numbers missing";
    });

    await callTool(srv, "tr_fetch_cached", { cache_key: mapCacheKey ?? "missing-key" });

    // ── creation ────────────────────────────────────────────────────────
    await callTool(srv, "tr_list_templates", {});
    const plan = await callTool(srv, "tr_plan_test", {
      project_id: projectId,
      journey_id: journeyId,
      goal: "cover the top uncovered journey",
    });
    const planKey = s<{ plan_cache_key?: string }>(plan).plan_cache_key;
    await callTool(srv, "tr_generate_test", {
      project_id: projectId,
      ...(planKey ? { plan_cache_key: planKey } : { plan: "1. open page\n2. assert title" }),
    });

    // tr_dry_run_test contains the path to outputDir (TEAI-271), so the spec
    // MUST live under it — write there, not in a separate tmp dir.
    const specPath = join(srv.__ctx.config.outputDir, "dogfood.spec.ts");
    mkdirSync(srv.__ctx.config.outputDir, { recursive: true });
    writeFileSync(
      specPath,
      "import { test, expect } from '@playwright/test';\n" +
        "test('dogfood', async () => { expect(1).toBe(1); });\n",
    );
    await callTool(srv, "tr_dry_run_test", { file_path: "dogfood.spec.ts" });
    await callTool(srv, "tr_generate_assertion", { step: "user sees the order confirmation page" });

    // ── healing ─────────────────────────────────────────────────────────
    await callTool(srv, "tr_heal_run", { run_id: failedRun });
    await callTool(srv, "tr_suggest_locator", {
      current_selector: "#submit-btn",
      context: "checkout form submit",
    });
    await callTool(srv, "tr_replay_failure", { run_id: failedRun });

    // ── impact ──────────────────────────────────────────────────────────
    const files = ["src/checkout/cart.ts", "src/auth/login.ts"];
    await callTool(srv, "tr_analyze_diff", { project_id: projectId, files });
    await callTool(srv, "tr_select_tests", { project_id: projectId, files });
    await callTool(srv, "tr_risk_score", { project_id: projectId, files });

    // ── triage ──────────────────────────────────────────────────────────
    await callTool(srv, "tr_diagnose_run", { run_id: failedRun });
    await callTool(srv, "tr_flaky_audit", { project_id: projectId });
    await callTool(srv, "tr_compare_runs", { run_id_a: runId, run_id_b: secondRun });
    await callTool(srv, "tr_search_failures", { query: "timeout" });
    await callTool(srv, "tr_ai_rca", { run_id: failedRun });
    await callTool(srv, "tr_suggest_fix", { run_id: failedRun, test_name: testName });
    await callTool(srv, "tr_create_jira", { run_id: failedRun, dry_run: true });
    await callTool(srv, "tr_dismiss_flaky", {
      test_id: testId,
      reason: "known infra flake, tracked separately",
    });

    // ── signals ─────────────────────────────────────────────────────────
    await callTool(srv, "tr_user_impact", { run_id: failedRun });
    await callTool(srv, "tr_production_signal", { query: "error", max_lines: 20 });
    await callTool(srv, "tr_affected_sessions", { run_id: failedRun, limit: 5 });

    // ── devtools ────────────────────────────────────────────────────────
    await callTool(srv, "tr_project_trends", { project_id: projectId, days: 7 });
    await callTool(srv, "tr_active_alerts", {});
    await callTool(srv, "tr_index_repo", { repo_root: join(process.cwd(), "packages", "mcp", "src"), max_files: 40 });
    await callTool(srv, "tr_search_code", { query: "capability registry", k: 3 });
    await callTool(srv, "tr_cache_stats", {});

    // ── ai ──────────────────────────────────────────────────────────────
    await callTool(srv, "tr_ai_list_tools", {});
    await callTool(srv, "tr_ai_execute", {
      tool_name: "generate_dashboard",
      input: { title: "Dogfood dashboard" },
    });
    await callTool(srv, "tr_ask_ai", { message: "How many runs failed this week?" });
    await callTool(srv, "tr_ai_list_conversations", {});
    const conv = await callTool(srv, "tr_ai_new_conversation", { title: "dogfood" });
    const convId = s<{ conversation?: { id?: string }; id?: string }>(conv).conversation?.id
      ?? s<{ id?: string }>(conv).id;
    await callTool(srv, "tr_ai_get_conversation", { id: convId ?? "conv-1" });
    await callTool(srv, "tr_ai_delete_conversation", { id: convId ?? "conv-1" });
    await callTool(srv, "tr_ai_usage", {});

    // ── marketplace ─────────────────────────────────────────────────────
    const apps = await callTool(srv, "tr_marketplace_list_apps", {});
    const slug = s<{ apps?: Array<{ slug: string }> }>(apps).apps?.[0]?.slug ?? "jira";
    await callTool(srv, "tr_marketplace_get_app", { slug });
    await callTool(srv, "tr_marketplace_list_connections", {});
    await callTool(srv, "tr_marketplace_validate", { slug, credentials: { token: "mock" } });
    await callTool(srv, "tr_marketplace_connect", { slug, credentials: { token: "mock" } });
    await callTool(srv, "tr_marketplace_start_oauth", { slug });
    await callTool(srv, "tr_marketplace_invoke", { slug, operation: "list_projects", args: {} });
    await callTool(srv, "tr_marketplace_disconnect", { slug });

    // ── apps ────────────────────────────────────────────────────────────
    const capps = await callTool(srv, "tr_apps_list", {});
    const app = s<{ apps?: Array<{ app?: string; slug?: string }> }>(capps).apps?.[0];
    const appName = app?.app ?? app?.slug ?? "slack";
    await callTool(srv, "tr_apps_list_actions", { app: appName });
    const connect = await callTool(srv, "tr_apps_connect", { app: appName });
    const connectionId =
      s<{ connection?: { id?: string }; connectionId?: string }>(connect).connection?.id ??
      s<{ connectionId?: string }>(connect).connectionId ??
      "conn-1";
    await callTool(srv, "tr_apps_execute", {
      app: appName,
      action: "send_message",
      args: { channel: "#dogfood", text: "hello from dogfood-all" },
    });
    await callTool(srv, "tr_apps_disconnect", { connectionId });

    // ── artifacts ───────────────────────────────────────────────────────
    const arts = await callTool(srv, "tr_artifacts_list", {});
    const artId = s<{ artifacts?: Array<{ id: string }> }>(arts).artifacts?.[0]?.id ?? "art-mock-1";
    await callTool(srv, "tr_artifacts_get", { id: artId });
    await callTool(srv, "tr_artifacts_export", { id: artId, format: "png" });
    await callTool(srv, "tr_artifacts_save_to_file", { id: artId, filename: "dogfood-artifact" });

    // ── memory ──────────────────────────────────────────────────────────
    await callTool(srv, "tr_get_repo_memory", { project_id: projectId });
    await callTool(srv, "tr_list_repo_memories", { project_id: projectId, limit: 5 });
    await callTool(srv, "tr_save_repo_memory", {
      project_id: projectId,
      title: "dogfood entry",
      content: "written by scripts/dogfood-all.ts against the mock server",
      category: "context",
    });

    // ── Completeness: every canonical tool must have been exercised ─────
    const missed = ALL_TOOLS.map((t) => t.name).filter((n) => !exercised.has(n));
    if (missed.length) hard.push(`tools never exercised: ${missed.join(", ")}`);

    // ── Truncation-recovery round-trip WITHOUT the coverage capability ──
    const tight = await boot(mockUrl, {
      capabilities: ["core", "triage"] as Capability[],
      tokenBudgetPerTool: 60,
    });
    try {
      const tightNames = new Set(tight.registeredTools.map((t) => t.name));
      if (!tightNames.has("tr_fetch_cached")) {
        hard.push("tr_fetch_cached not registered under --caps core,triage (3.3.0 fix regressed)");
      }
      const mapTool = ALL_TOOLS.find((t) => t.name === "tr_test_map")!;
      const big = (await mapTool.handler({ project_id: projectId }, tight.__ctx)) as {
        cacheKey?: string;
        structured?: { cache_key?: string };
      };
      const key = big.cacheKey ?? big.structured?.cache_key;
      if (!key) {
        hard.push("truncated result carried no cacheKey to redeem");
      } else {
        const fetchTool = ALL_TOOLS.find((t) => t.name === "tr_fetch_cached")!;
        const redeemed = (await fetchTool.handler({ cache_key: key }, tight.__ctx)) as {
          text: string;
          isError?: boolean;
        };
        if (redeemed.isError || !redeemed.text?.trim()) {
          hard.push("tr_fetch_cached could not redeem the cacheKey");
        }
      }
    } finally {
      await tight.stop().catch(() => undefined);
    }

    // ── Legacy alias matrix ─────────────────────────────────────────────
    const legacy = await boot(mockUrl, { legacyAliases: true });
    try {
      const legacyNames = legacy.registeredTools.map((t) => t.name);
      const aliasNames = legacyNames.filter((n) => n.startsWith("testrelic_"));
      if (legacyNames.length !== 80) {
        hard.push(`legacyAliases: expected 80 names, got ${legacyNames.length}`);
      }
      if (aliasNames.length !== 14) {
        hard.push(`legacyAliases: expected 14 testrelic_* names, got ${aliasNames.length}`);
      }
      if (!aliasNames.includes("testrelic_list_runs")) {
        hard.push("testrelic_list_runs missing — the re-homed alias regressed");
      }
    } finally {
      await legacy.stop().catch(() => undefined);
    }
  } finally {
    await srv.stop().catch(() => undefined);
    mock.kill("SIGTERM");
    await Promise.race([once(mock, "exit"), new Promise((r) => setTimeout(r, 3_000))]);
  }

  // ── Report ────────────────────────────────────────────────────────────
  for (const r of rows) {
    process.stdout.write(`[${r.ok ? "PASS" : "FAIL"}] ${r.tool.padEnd(32)} ${r.detail}\n`);
  }
  const failed = rows.filter((r) => !r.ok);
  process.stdout.write(`\nTools: ${rows.length - failed.length}/${rows.length} passed`);
  process.stdout.write(` — exercised ${exercised.size}/${ALL_TOOLS.length} registered tools\n`);
  for (const h of hard) process.stdout.write(`[HARD-FAIL] ${h}\n`);
  return failed.length === 0 && hard.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`dogfood crashed: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(2);
  },
);
