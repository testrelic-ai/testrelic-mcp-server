#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import "dotenv/config";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createServer } from "./index.js";
import { loadConfigFile, tokenFilePath } from "./config.js";
import { getLogger } from "./logger.js";
import { version } from "./version.js";
import type { Capability, Config, LogLevel } from "./config.js";

/**
 * CLI surface for the TestRelic MCP server.
 *
 * Usage:
 *   mcp-server-testrelic login [--token=<tr_mcp_*>]     # save a PAT to ~/.testrelic/token
 *   mcp-server-testrelic [options]                      # run the server (default)
 *
 * The server reads its PAT from (in order):
 *   1. --token CLI flag
 *   2. TESTRELIC_MCP_TOKEN env var
 *   3. ~/.testrelic/token file (written by `login`)
 *
 * No per-integration flags exist in v2 — the MCP fetches all integration
 * config from /api/v1/mcp/bootstrap using the PAT.
 */

function saveTokenToFile(token: string): string {
  const path = tokenFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows doesn't support 0600, that's fine.
  }
  return path;
}

async function runLogin(flags: { token?: string; cloudUrl?: string }): Promise<void> {
  const cloudUrl = flags.cloudUrl ?? "https://app.testrelic.ai";
  const tokensUrl = cloudUrl.replace(/\/api\/v1\/?$/, "").replace(/\/$/, "") + "/settings/mcp-tokens";
  let token = flags.token ?? process.env.TESTRELIC_MCP_TOKEN;
  if (!token) {
    console.log("Generate a new MCP Personal Access Token here:");
    console.log(`  ${tokensUrl}`);
    console.log("");
    const rl = readline.createInterface({ input, output });
    token = (await rl.question("Paste your token (tr_mcp_*): ")).trim();
    rl.close();
  }
  if (!token || !token.startsWith("tr_mcp_")) {
    console.error("Invalid token. Expected a token starting with 'tr_mcp_'.");
    process.exit(1);
  }
  const path = saveTokenToFile(token);
  console.log(`Saved token to ${path}`);
}

async function main(): Promise<void> {
  const parser = yargs(hideBin(process.argv))
    .scriptName("mcp-server-testrelic")
    .usage("$0 [command] [options]")
    .command(
      "login",
      "Save an MCP Personal Access Token to ~/.testrelic/token",
      (y) =>
        y
          .option("token", {
            type: "string",
            describe: "Token value (tr_mcp_*). If omitted, you'll be prompted.",
          })
          .option("cloud-url", {
            type: "string",
            describe: "Cloud UI URL (used only to print the settings link).",
          }),
      async (argv) => {
        await runLogin({
          token: argv.token as string | undefined,
          cloudUrl: (argv["cloud-url"] as string | undefined) ?? (argv.cloudUrl as string | undefined),
        });
      },
    )
    .option("caps", {
      type: "string",
      describe: "Comma-separated capabilities to enable (core is always on).",
    })
    .option("config", {
      type: "string",
      describe: "Path to a JSON config file.",
    })
    .option("port", {
      type: "number",
      describe: "Start HTTP transport on this port (stdio is used when unset).",
    })
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      describe: "HTTP bind host.",
    })
    .option("output-dir", {
      type: "string",
      describe: "Where traces, reports, metrics.jsonl go.",
    })
    .option("cache-dir", {
      type: "string",
      describe: "Where SQLite/HNSW/blob caches live.",
    })
    .option("isolated", {
      type: "boolean",
      default: false,
      describe: "Wipe cacheDir at boot for reproducible runs.",
    })
    .option("save-session", {
      type: "boolean",
      default: true,
      describe: "Persist cache state across restarts.",
    })
    .option("shared-repo-context", {
      type: "boolean",
      default: true,
      describe: "Share CodeMap across tool calls in the same session.",
    })
    .option("cloud-url", {
      type: "string",
      describe: "Base URL for cloud-platform-app (env: TESTRELIC_CLOUD_URL). Defaults to https://app.testrelic.ai/api/v1 (prod) or mock-server URL in --mock-mode.",
    })
    .option("token", {
      type: "string",
      describe: "MCP PAT (env: TESTRELIC_MCP_TOKEN). Defaults to ~/.testrelic/token (written by `login`).",
    })
    .option("default-repo-id", {
      type: "string",
      describe: "Repo UUID to use when tools don't specify project_id.",
    })
    .option("mock-mode", {
      type: "boolean",
      default: false,
      describe: "Point the cloud client at the local mock-server instead of the real platform.",
    })
    .option("mock-server-url", {
      type: "string",
      default: "http://localhost:4000",
      describe: "Base URL for the mock server (only meaningful with --mock-mode).",
    })
    .option("log-level", {
      type: "string",
      choices: ["debug", "info", "warn", "error"] as const,
      default: "info" as const,
      describe: "pino log level (STDERR only).",
    })
    .option("token-budget", {
      type: "number",
      describe: "Per-tool token budget ceiling (default 4000).",
    })
    .help()
    .alias("h", "help")
    .version(version)
    .alias("v", "version")
    .strict();

  const argv = await parser.parseAsync();
  // If a subcommand ran, yargs will have exited already; any remaining path is the default server run.
  if ((argv._?.[0] as string | undefined) === "login") return;

  let fileConfig: Config | undefined;
  if (argv.config) fileConfig = loadConfigFile(argv.config);

  const cliCloud: Config["cloud"] = {};
  if (argv.cloudUrl) cliCloud.baseUrl = argv.cloudUrl as string;
  if (argv.token) cliCloud.token = argv.token as string;
  if (argv.defaultRepoId) cliCloud.defaultRepoId = argv.defaultRepoId as string;

  const cliConfig: Config = {
    ...(argv.port ? { server: { port: argv.port, host: argv.host } } : {}),
    ...(argv.caps
      ? {
          capabilities: argv.caps.split(",").map((s: string) => s.trim()).filter(Boolean) as Capability[],
        }
      : {}),
    ...(argv.outputDir ? { outputDir: argv.outputDir } : {}),
    ...(argv.cacheDir ? { cacheDir: argv.cacheDir } : {}),
    isolated: argv.isolated,
    saveSession: argv.saveSession,
    sharedRepoContext: argv.sharedRepoContext,
    mockMode: argv.mockMode,
    mockServerUrl: argv.mockServerUrl,
    logLevel: argv.logLevel as LogLevel,
    ...(Object.keys(cliCloud).length > 0 ? { cloud: cliCloud } : {}),
    ...(argv.tokenBudget ? { tokenBudgetPerTool: argv.tokenBudget } : {}),
  };

  const { start, config, registeredTools } = await createServer({
    ...(fileConfig ?? {}),
    ...cliConfig,
  });

  getLogger().info(
    {
      version,
      transport: config.server.transport,
      capabilities: config.capabilities,
      tools: registeredTools.length,
      cloudUrl: config.cloud.baseUrl,
      mockMode: config.mockMode,
      tokenPresent: !!config.cloud.token,
    },
    "starting TestRelic MCP",
  );

  await start();
}

main().catch((err) => {
  getLogger().error({ err }, "fatal");
  process.exit(1);
});
