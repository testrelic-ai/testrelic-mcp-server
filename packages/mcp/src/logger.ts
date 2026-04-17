import pino from "pino";
import type { LogLevel } from "./config.js";

/**
 * Structured logger that writes to STDERR only. MCP stdio transport uses
 * STDOUT exclusively for JSON-RPC frames — logging to stdout breaks clients.
 */

let logger: pino.Logger | null = null;

export function createLogger(level: LogLevel = "info"): pino.Logger {
  logger = pino(
    {
      level,
      base: { svc: "testrelic-mcp" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    pino.destination({ dest: 2, sync: false }),
  );
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = createLogger("info");
  }
  return logger;
}

export function setLogLevel(level: LogLevel): void {
  getLogger().level = level;
}
