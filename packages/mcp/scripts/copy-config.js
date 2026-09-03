#!/usr/bin/env node
/**
 * Verifies the compiled config declaration (dist/config.d.ts) exposes the
 * documented public shape. The runtime source of truth is the Zod schema
 * in src/config.ts; tsc emits dist/config.d.ts from its types.
 *
 * This script exits non-zero when expected fields drift so CI catches it.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), "..");
const distDts = join(packageRoot, "dist", "config.d.ts");

if (!existsSync(distDts)) {
  console.error(`dist/config.d.ts is missing — run \`npm --workspace @testrelic/mcp run build\` first.`);
  process.exit(2);
}

const text = readFileSync(distDts, "utf-8");
const requiredFields = [
  "server",
  "capabilities",
  "timeouts",
  "outputDir",
  "cacheDir",
  "isolated",
  "saveSession",
  "sharedRepoContext",
  "cloud",
  "logLevel",
  "mockMode",
  "mockServerUrl",
  "tokenBudgetPerTool",
];
const missing = requiredFields.filter((f) => !new RegExp(`\\b${f}\\b`).test(text));
if (missing.length) {
  console.error(`dist/config.d.ts is missing expected fields: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`dist/config.d.ts exposes all ${requiredFields.length} expected fields.`);
