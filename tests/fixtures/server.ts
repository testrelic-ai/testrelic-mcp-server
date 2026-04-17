import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { createServer, type TestRelicServer } from "../../packages/mcp/src/index.js";
import type { Capability, Config } from "../../packages/mcp/src/config.js";

/**
 * Minimal test fixture: boots the MCP server in-process (no transport)
 * so we can call its tool handlers directly via the internal __ctx surface.
 */

export async function startInProcessServer(overrides: Partial<Config> = {}): Promise<TestRelicServer> {
  const mockUrl = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
  // Every test gets its own cache/output directory to avoid concurrent
  // EPERM / ENOTEMPTY races on Windows.
  const id = randomUUID().slice(0, 8);
  const server = await createServer({
    capabilities: ["core", "coverage", "creation", "healing", "impact", "triage", "signals", "devtools"] as Capability[],
    mockMode: true,
    mockServerUrl: mockUrl,
    logLevel: "warn",
    isolated: true,
    saveSession: false,
    outputDir: join(tmpdir(), `testrelic-mcp-test-out-${id}`),
    cacheDir: join(tmpdir(), `testrelic-mcp-test-cache-${id}`),
    ...overrides,
  });
  return server;
}

/**
 * Ask the OS for a free TCP port on localhost.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("failed to pick a free port"));
      }
    });
  });
}

/**
 * Spawns the tsx-compiled mock server on a random free port.
 * Sets MOCK_SERVER_URL in process.env so startInProcessServer sees it.
 */
export async function startMockServer(): Promise<ChildProcess> {
  const port = await findFreePort();
  process.env.MOCK_SERVER_URL = `http://localhost:${port}`;
  const child = spawn("npx", ["tsx", "mock-server/index.ts"], {
    env: { ...process.env, MOCK_SERVER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (!child.stdout) throw new Error("mock server stdout missing");
  await waitForOutput(child, /Running on http:/);
  return child;
}

async function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const chunks: string[] = [];
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      chunks.push(text);
      if (pattern.test(text)) {
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`mock server exited early (code=${code}): ${chunks.join("")}`)));
    setTimeout(() => reject(new Error("mock server failed to start within 15s")), 15_000).unref();
  });
}

export async function stopMockServer(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3_000))]);
}
