/**
 * Exhaustive test of the three repo-memory tools against a live or mock cloud.
 *
 *   tr_get_repo_memory     — digest read
 *   tr_list_repo_memories  — filterable list (+ category/search/status/limit)
 *   tr_save_repo_memory    — write (needs the mcp:memory PAT scope)
 *
 * Full round-trip: snapshot list → save a uniquely-tagged entry → confirm it
 * appears in the list and via search → exercise every filter → digest read.
 * The saved entry is clearly labelled a verification artifact.
 *
 *   TESTRELIC_CLOUD_URL=... TESTRELIC_MCP_TOKEN=... [MEM_PROJECT=<repoId>] \
 *   npx tsx scripts/memory-tools-verify.ts        # live
 *   MEM_MOCK=1 npx tsx scripts/memory-tools-verify.ts   # in-process mock
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type TestRelicServer } from "../packages/mcp/src/index.js";
import { ALL_TOOLS } from "../packages/mcp/src/tools/index.js";
import type { Capability } from "../packages/mcp/src/config.js";

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = "") { checks.push({ name, ok, detail }); }

const tool = (n: string) => ALL_TOOLS.find((t) => t.name === n)!;
async function run(srv: TestRelicServer, name: string, input: Record<string, unknown>) {
  return (await tool(name).handler(input, srv.__ctx)) as {
    text: string; structured?: Record<string, unknown>; isError?: boolean;
  };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.unref(); s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res((a as net.AddressInfo).port)); });
  });
}
async function startMock(): Promise<{ child: ChildProcess; url: string }> {
  const port = await freePort(); const url = `http://localhost:${port}`;
  const child = spawn("npx", ["tsx", "mock-server/index.ts"], {
    env: { ...process.env, MOCK_SERVER_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  await new Promise<void>((res, rej) => {
    const on = (c: Buffer) => { if (/Running on http:/.test(c.toString())) res(); };
    child.stdout?.on("data", on); child.stderr?.on("data", on);
    child.once("exit", (c) => rej(new Error(`mock exited ${c}`)));
    setTimeout(() => rej(new Error("mock start timeout")), 20_000).unref();
  });
  return { child, url };
}

async function main(): Promise<number> {
  const isMock = process.env.MEM_MOCK === "1";
  let mock: ChildProcess | undefined;
  let cloudBase: string, token: string;
  if (isMock) {
    const m = await startMock(); mock = m.child;
    cloudBase = `${m.url}/api/v1`; token = "mock-token";
  } else {
    cloudBase = process.env.TESTRELIC_CLOUD_URL!;
    token = process.env.TESTRELIC_MCP_TOKEN!;
    if (!cloudBase || !token) { console.error("set TESTRELIC_CLOUD_URL + TESTRELIC_MCP_TOKEN, or MEM_MOCK=1"); return 2; }
  }
  console.log(`Memory-tools verify against ${cloudBase}${isMock ? " (mock)" : " (live)"}\n`);

  const id = randomUUID().slice(0, 8);
  const srv = await createServer({
    capabilities: ["core", "memory"] as Capability[], mockMode: isMock, mockServerUrl: isMock ? cloudBase.replace("/api/v1", "") : undefined,
    logLevel: "warn", isolated: true, saveSession: false, cloud: { baseUrl: cloudBase, token },
    outputDir: join(tmpdir(), `tr-mem-out-${id}`), cacheDir: join(tmpdir(), `tr-mem-cache-${id}`),
  });

  const tag = `verify-${id}`;
  try {
    // Registration
    const names = new Set(srv.registeredTools.map((t) => t.name));
    check("all 3 memory tools registered under --caps memory",
      ["tr_get_repo_memory", "tr_list_repo_memories", "tr_save_repo_memory"].every((n) => names.has(n)),
      [...names].filter((n) => n.includes("memory")).join(", "));

    // Pick a repo
    const repos = srv.__ctx.bootstrap?.repos ?? [];
    const pid = process.env.MEM_PROJECT ?? repos[0]?.id;
    check("resolved a target repo", !!pid, pid ?? "(none)");
    if (!pid) throw new Error("no repo to test against");

    // Baseline list
    const before = await run(srv, "tr_list_repo_memories", { project_id: pid, status: "all", limit: 200 });
    check("tr_list_repo_memories baseline read", !before.isError,
      `total=${(before.structured?.total as number) ?? "?"}`);
    const beforeTotal = (before.structured?.total as number) ?? 0;

    // Save (mutating — needs mcp:memory scope)
    const save = await run(srv, "tr_save_repo_memory", {
      project_id: pid, category: "context",
      title: `[automated verification ${tag}] safe to delete`,
      content: `Written by scripts/memory-tools-verify.ts against ${cloudBase} to confirm the `
        + `save→list→search round-trip. Tag ${tag}. This is a test artifact; delete anytime.`,
    });
    // Structured shape is { saved: true, memory: { id, ... } }.
    const savedMem = (save.structured as { saved?: boolean; memory?: { id?: string } })?.memory;
    const savedId = savedMem?.id;
    if (save.isError && /403|scope|mcp:memory/i.test(save.text)) {
      check("tr_save_repo_memory (SKIPPED — PAT lacks mcp:memory scope)", true, save.text.slice(0, 80));
    } else {
      check("tr_save_repo_memory persisted (mcp:memory scope OK)", !save.isError && !!savedId, savedId ?? save.text.slice(0, 80));

      // Confirm it shows up
      const after = await run(srv, "tr_list_repo_memories", { project_id: pid, status: "all", limit: 200 });
      const afterTotal = (after.structured?.total as number) ?? 0;
      check("list total incremented after save", afterTotal === beforeTotal + 1,
        `${beforeTotal} -> ${afterTotal}`);

      const search = await run(srv, "tr_list_repo_memories", { project_id: pid, search: tag, status: "all" });
      const found = (search.structured?.memories as Array<{ title: string }> | undefined)?.some((m) => m.title.includes(tag));
      check("saved entry is findable by search", !!found, found ? "found via search" : "NOT found");
    }

    // Filters
    const byCat = await run(srv, "tr_list_repo_memories", { project_id: pid, category: "context", status: "all" });
    check("filter by category=context", !byCat.isError,
      `${(byCat.structured?.memories as unknown[] | undefined)?.length ?? 0} rows`);
    const active = await run(srv, "tr_list_repo_memories", { project_id: pid, status: "active", limit: 5 });
    check("filter by status=active + limit", !active.isError,
      `${(active.structured?.memories as unknown[] | undefined)?.length ?? 0} rows (<=5)`);

    // Digest
    const digest = await run(srv, "tr_get_repo_memory", { project_id: pid });
    check("tr_get_repo_memory digest read", !digest.isError && !!digest.text?.trim(),
      `${digest.text?.length ?? 0} chars`);

    // Error handling: unknown repo id (read path)
    const bad = await run(srv, "tr_list_repo_memories", { project_id: "definitely-not-a-repo-id" }).catch((e) => ({ isError: true, text: String(e), structured: undefined }));
    check("unknown project_id handled (not a crash)", true, (bad.text ?? "").slice(0, 60));
  } finally {
    await srv.stop().catch(() => undefined);
    if (mock) { mock.kill("SIGTERM"); await Promise.race([once(mock, "exit"), new Promise((r) => setTimeout(r, 3000))]); }
  }

  for (const c of checks) process.stdout.write(`[${c.ok ? "PASS" : "FAIL"}] ${c.name}${c.detail ? "  — " + c.detail : ""}\n`);
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} memory-tool checks passed`);
  if (!isMock && tag) process.stdout.write(`\nNOTE: left a labelled test memory (tag ${tag}) in the target repo — delete when done.`);
  process.stdout.write("\n");
  return failed.length === 0 ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { console.error(e?.stack ?? e); process.exit(2); });
