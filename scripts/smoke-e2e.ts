/**
 * MCP smoke / E2E walk.
 *
 * Boots the MCP server in-process against the local mock server (or a real
 * platform via `TESTRELIC_CLOUD_URL` + `TESTRELIC_MCP_TOKEN`), then drives
 * a canonical sequence of tools across the new capabilities. Each step prints
 * a one-line PASS / FAIL summary; the script exits 0 on full pass and 1
 * otherwise.
 *
 * Usage:
 *   npx tsx scripts/smoke-e2e.ts
 *   npx tsx scripts/smoke-e2e.ts --caps=core,ai,marketplace,apps,artifacts,sessions
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

const DEFAULT_CAPS = ["core", "ai", "marketplace", "apps", "artifacts", "sessions"] as const;

function parseCaps(argv: string[]): Capability[] {
  const flag = argv.find((a) => a.startsWith("--caps="));
  const raw = flag?.slice("--caps=".length) ?? DEFAULT_CAPS.join(",");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Capability[];
}

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
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

async function startMockServer(): Promise<{ child: ChildProcess; url: string }> {
  const port = await findFreePort();
  const url = `http://localhost:${port}`;
  const child = spawn("npx", ["tsx", "mock-server/index.ts"], {
    env: { ...process.env, MOCK_SERVER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (/Running on http:/.test(text)) {
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`mock server exited early (code=${code})`)));
    setTimeout(() => reject(new Error("mock server failed to start within 15s")), 15_000).unref();
  });
  return { child, url };
}

async function stopMockServer(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3_000))]);
}

async function runStep(
  srv: TestRelicServer,
  step: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<StepResult> {
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) return { step, ok: false, detail: `tool not registered: ${toolName}` };
  try {
    const result = await tool.handler(input, srv.__ctx);
    const isError = (result as { isError?: boolean }).isError === true;
    if (isError) return { step, ok: false, detail: "handler returned isError" };
    const summary = (result.text ?? "").split("\n")[0]?.slice(0, 80) ?? "(no text)";
    return { step, ok: true, detail: summary };
  } catch (err) {
    return { step, ok: false, detail: (err as Error).message };
  }
}

function logResult(r: StepResult): void {
  const tag = r.ok ? "PASS" : "FAIL";
  process.stdout.write(`[${tag}] ${r.step} — ${r.detail}\n`);
}

async function main(): Promise<number> {
  const caps = parseCaps(process.argv.slice(2));
  process.stdout.write(`MCP smoke E2E — caps=${caps.join(",")}\n`);

  const { child: mock, url: mockUrl } = await startMockServer();
  const id = randomUUID().slice(0, 8);
  const srv = await createServer({
    capabilities: caps,
    mockMode: true,
    mockServerUrl: mockUrl,
    logLevel: "warn",
    isolated: true,
    saveSession: false,
    outputDir: join(tmpdir(), `tr-smoke-out-${id}`),
    cacheDir: join(tmpdir(), `tr-smoke-cache-${id}`),
  });

  const results: StepResult[] = [];
  let firstArtifactId: string | undefined;

  try {
    results.push(await runStep(srv, "list repos", "tr_list_repos", {}));
    results.push(await runStep(srv, "list marketplace apps", "tr_marketplace_list_apps", {}));
    results.push(await runStep(srv, "list connected apps", "tr_apps_list", {}));
    results.push(await runStep(srv, "list AI tools", "tr_ai_list_tools", {}));
    results.push(
      await runStep(srv, "generate dashboard", "tr_generate_dashboard", {
        input: { title: "Smoke dashboard" },
      }),
    );

    const artifactsList = await runStep(srv, "list artifacts", "tr_artifacts_list", {});
    results.push(artifactsList);
    if (artifactsList.ok) {
      // Pull the first id from the structured payload for the get step.
      const tool = ALL_TOOLS.find((t) => t.name === "tr_artifacts_list");
      if (tool) {
        const r = await tool.handler({}, srv.__ctx);
        const structured = r.structured as { artifacts?: Array<{ id: string }> } | undefined;
        firstArtifactId = structured?.artifacts?.[0]?.id;
      }
    }

    results.push(
      await runStep(srv, "get first artifact", "tr_artifacts_get", {
        id: firstArtifactId ?? "art-mock-1",
      }),
    );

    results.push(
      await runStep(srv, "execute apps action (slack send_message)", "tr_apps_execute", {
        app: "slack",
        action: "send_message",
        args: { channel: "#general", text: "hi" },
      }),
    );

    for (const r of results) logResult(r);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`\nSummary: ${results.length - failed.length}/${results.length} steps passed.\n`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await srv.stop().catch(() => undefined);
    await stopMockServer(mock).catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`smoke script crashed: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(2);
  },
);
