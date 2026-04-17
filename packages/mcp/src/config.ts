import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

/**
 * All Zod schemas live here. The public type surface is defined directly
 * below and is verified against `src/config.d.ts` by `scripts/copy-config.js`
 * to keep the two surfaces in lock-step.
 *
 * The v2 config is radically simpler than v1: the MCP talks to exactly one
 * upstream (cloud-platform-app). Everything else — Jira, Amplitude, Loki,
 * GitHub — is resolved server-side from the authenticated user's org
 * integrations. See cloud-platform-app/server/src/routes/mcp.routes.ts.
 */

export const CapabilitySchema = z.enum([
  "core",
  "coverage",
  "creation",
  "healing",
  "impact",
  "triage",
  "signals",
  "devtools",
  "config",
]);

export const TransportSchema = z.enum(["stdio", "http"]);

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export type Capability = z.infer<typeof CapabilitySchema>;
export type Transport = z.infer<typeof TransportSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ServerConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().optional(),
    transport: TransportSchema.optional(),
  })
  .strict();

export const TimeoutConfigSchema = z
  .object({
    action: z.number().int().positive().optional(),
    upstream: z.number().int().positive().optional(),
    analysis: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The ONE place users configure authentication. Everything else is pulled
 * automatically from /api/v1/mcp/bootstrap once the MCP authenticates.
 */
export const CloudConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    token: z.string().optional(),
    defaultRepoId: z.string().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    server: ServerConfigSchema.optional(),
    capabilities: z.array(CapabilitySchema).optional(),
    timeouts: TimeoutConfigSchema.optional(),
    outputDir: z.string().optional(),
    cacheDir: z.string().optional(),
    isolated: z.boolean().optional(),
    saveSession: z.boolean().optional(),
    sharedRepoContext: z.boolean().optional(),
    cloud: CloudConfigSchema.optional(),
    logLevel: LogLevelSchema.optional(),
    mockMode: z.boolean().optional(),
    mockServerUrl: z.string().optional(),
    tokenBudgetPerTool: z.number().int().positive().optional(),
  })
  .strict();

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type CloudConfig = z.infer<typeof CloudConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  server: Required<ServerConfig> & { port: number };
  capabilities: Capability[];
  timeouts: Required<TimeoutConfig>;
  outputDir: string;
  cacheDir: string;
  isolated: boolean;
  saveSession: boolean;
  sharedRepoContext: boolean;
  cloud: {
    baseUrl: string;
    token: string;
    defaultRepoId: string | undefined;
  };
  logLevel: LogLevel;
  mockMode: boolean;
  mockServerUrl: string;
  tokenBudgetPerTool: number;
}

const DEFAULT_CLOUD_URL = "https://app.testrelic.ai/api/v1";
const TOKEN_FILE = join(homedir(), ".testrelic", "token");

/**
 * Read the token from ~/.testrelic/token if it exists. Silently returns
 * undefined otherwise — callers decide whether missing = fatal.
 */
export function readTokenFile(path: string = TOKEN_FILE): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf-8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}

/**
 * Load a JSON config file from disk and validate it.
 */
export function loadConfigFile(path: string): Config {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Config file not found: ${absolute}`);
  }
  const text = readFileSync(absolute, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config file ${absolute} is not valid JSON: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Config file ${absolute} failed validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Merge precedence (highest wins): CLI flags > env > config file > defaults.
 */
export function mergeConfig(...layers: Array<Config | undefined>): Config {
  const merged: Config = {};
  for (const layer of layers) {
    if (!layer) continue;
    merged.server = { ...merged.server, ...layer.server };
    merged.timeouts = { ...merged.timeouts, ...layer.timeouts };
    merged.cloud = { ...merged.cloud, ...layer.cloud };
    if (layer.capabilities) merged.capabilities = [...layer.capabilities];
    if (layer.outputDir !== undefined) merged.outputDir = layer.outputDir;
    if (layer.cacheDir !== undefined) merged.cacheDir = layer.cacheDir;
    if (layer.isolated !== undefined) merged.isolated = layer.isolated;
    if (layer.saveSession !== undefined) merged.saveSession = layer.saveSession;
    if (layer.sharedRepoContext !== undefined) merged.sharedRepoContext = layer.sharedRepoContext;
    if (layer.logLevel !== undefined) merged.logLevel = layer.logLevel;
    if (layer.mockMode !== undefined) merged.mockMode = layer.mockMode;
    if (layer.mockServerUrl !== undefined) merged.mockServerUrl = layer.mockServerUrl;
    if (layer.tokenBudgetPerTool !== undefined) merged.tokenBudgetPerTool = layer.tokenBudgetPerTool;
  }
  return merged;
}

/**
 * Apply defaults and normalize.
 *
 * In mockMode, the cloud baseUrl defaults to `${mockServerUrl}/api/v1` so the
 * MCP transparently hits the local mock-server. Otherwise it defaults to the
 * production platform URL and pulls the token from ~/.testrelic/token.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const parsed = ConfigSchema.parse(config);
  const cwd = process.cwd();
  const port = parsed.server?.port;
  const transport: Transport = parsed.server?.transport ?? (port ? "http" : "stdio");
  const mockMode = parsed.mockMode ?? false;
  const mockServerUrl = parsed.mockServerUrl ?? "http://localhost:4000";
  const baseUrl = parsed.cloud?.baseUrl
    ?? (mockMode ? `${mockServerUrl}/api/v1` : DEFAULT_CLOUD_URL);
  const token = parsed.cloud?.token ?? readTokenFile() ?? "";
  return {
    server: {
      port: port ?? 0,
      host: parsed.server?.host ?? "127.0.0.1",
      transport,
    },
    capabilities: Array.from(new Set<Capability>(["core", ...((parsed.capabilities ?? []) as Capability[])])),
    timeouts: {
      action: parsed.timeouts?.action ?? 5_000,
      upstream: parsed.timeouts?.upstream ?? 60_000,
      analysis: parsed.timeouts?.analysis ?? 30_000,
    },
    outputDir: parsed.outputDir ?? resolve(cwd, ".testrelic-output"),
    cacheDir: parsed.cacheDir ?? resolve(cwd, ".testrelic-cache"),
    isolated: parsed.isolated ?? false,
    saveSession: parsed.saveSession ?? true,
    sharedRepoContext: parsed.sharedRepoContext ?? true,
    cloud: {
      baseUrl,
      token,
      defaultRepoId: parsed.cloud?.defaultRepoId,
    },
    logLevel: parsed.logLevel ?? "info",
    mockMode,
    mockServerUrl,
    tokenBudgetPerTool: parsed.tokenBudgetPerTool ?? 4_000,
  };
}

/**
 * Pick config from environment variables. Only reads at top level — no secret
 * values are logged.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const c: Config = {};
  const caps = env.TESTRELIC_MCP_CAPS;
  if (caps) {
    c.capabilities = caps
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as Capability[];
  }
  if (env.TESTRELIC_MCP_PORT) c.server = { port: Number(env.TESTRELIC_MCP_PORT) };
  if (env.TESTRELIC_MCP_HOST) c.server = { ...c.server, host: env.TESTRELIC_MCP_HOST };
  if (env.TESTRELIC_MCP_OUTPUT_DIR) c.outputDir = env.TESTRELIC_MCP_OUTPUT_DIR;
  if (env.TESTRELIC_MCP_CACHE_DIR) c.cacheDir = env.TESTRELIC_MCP_CACHE_DIR;
  if (env.TESTRELIC_MCP_ISOLATED) {
    c.isolated = env.TESTRELIC_MCP_ISOLATED === "1" || env.TESTRELIC_MCP_ISOLATED === "true";
  }
  if (env.TESTRELIC_MCP_LOG_LEVEL) c.logLevel = env.TESTRELIC_MCP_LOG_LEVEL as LogLevel;
  if (env.MOCK_SERVER_URL) c.mockServerUrl = env.MOCK_SERVER_URL;
  if (env.TESTRELIC_MOCK_MODE) {
    c.mockMode = env.TESTRELIC_MOCK_MODE === "1" || env.TESTRELIC_MOCK_MODE === "true";
  }

  const cloud: CloudConfig = {};
  if (env.TESTRELIC_CLOUD_URL) cloud.baseUrl = env.TESTRELIC_CLOUD_URL;
  if (env.TESTRELIC_MCP_TOKEN) cloud.token = env.TESTRELIC_MCP_TOKEN;
  if (env.TESTRELIC_DEFAULT_REPO_ID) cloud.defaultRepoId = env.TESTRELIC_DEFAULT_REPO_ID;
  if (Object.keys(cloud).length > 0) c.cloud = cloud;

  return c;
}
