import * as vscode from "vscode";
import { createServer, type TestRelicServer } from "@testrelic/mcp";
import type { Capability } from "@testrelic/mcp";

/**
 * VSCode / Cursor extension that hosts the TestRelic MCP server in the
 * editor process. The extension also exposes a thin bridge for the agent
 * to read live workspace state (active file, diff, open terminals).
 *
 * Commands:
 *   TestRelic MCP: Start Server
 *   TestRelic MCP: Stop Server
 *   TestRelic MCP: Show Status
 */

let running: TestRelicServer | null = null;
let statusItem: vscode.StatusBarItem | null = null;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = "$(play) TestRelic MCP";
  statusItem.command = "testrelic-mcp.showStatus";
  statusItem.show();
  ctx.subscriptions.push(statusItem);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("testrelic-mcp.start", () => startServer()),
    vscode.commands.registerCommand("testrelic-mcp.stop", () => stopServer()),
    vscode.commands.registerCommand("testrelic-mcp.showStatus", () => showStatus()),
  );

  const cfg = vscode.workspace.getConfiguration("testrelicMcp");
  if (cfg.get<boolean>("autoStart", true)) {
    await startServer();
  }
}

export async function deactivate(): Promise<void> {
  await stopServer();
}

async function startServer(): Promise<void> {
  if (running) {
    vscode.window.showInformationMessage("TestRelic MCP server already running.");
    return;
  }
  try {
    const cfg = vscode.workspace.getConfiguration("testrelicMcp");
    const port = cfg.get<number>("port", 0);
    const caps = cfg.get<string[]>("capabilities", ["core", "coverage", "creation", "healing", "impact"]);
    running = await createServer({
      ...(port > 0 ? { server: { port } } : {}),
      capabilities: caps as Capability[],
    });
    await running.start();
    updateStatus("running");
    vscode.window.showInformationMessage(
      `TestRelic MCP started (${running.config.server.transport}) — ${running.registeredTools.length} tools.`,
    );
  } catch (err) {
    running = null;
    updateStatus("error");
    vscode.window.showErrorMessage(`Failed to start TestRelic MCP: ${(err as Error).message}`);
  }
}

async function stopServer(): Promise<void> {
  if (!running) return;
  try {
    await running.stop();
  } catch (err) {
    vscode.window.showWarningMessage(`TestRelic MCP shutdown warning: ${(err as Error).message}`);
  }
  running = null;
  updateStatus("stopped");
}

function showStatus(): void {
  if (!running) {
    vscode.window.showInformationMessage("TestRelic MCP is stopped.");
    return;
  }
  const c = running.config;
  const panel = [
    `TestRelic MCP is running.`,
    `Transport: ${c.server.transport}${c.server.transport === "http" ? `:${c.server.port}` : ""}`,
    `Capabilities: ${c.capabilities.join(", ")}`,
    `Tools registered: ${running.registeredTools.length}`,
    `Output dir: ${c.outputDir}`,
    `Cache dir: ${c.cacheDir}`,
  ].join("\n");
  vscode.window.showInformationMessage(panel, { modal: true });
}

function updateStatus(state: "running" | "stopped" | "error"): void {
  if (!statusItem) return;
  statusItem.text =
    state === "running"
      ? "$(testing-passed-icon) TestRelic MCP"
      : state === "error"
        ? "$(error) TestRelic MCP"
        : "$(play) TestRelic MCP";
  statusItem.tooltip = `TestRelic MCP — ${state}`;
}
