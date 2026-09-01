#!/usr/bin/env node
/**
 * Fills the tool inventory in the agent skill from the real `ALL_TOOLS` array.
 *
 * The skill's tool list was previously maintained by hand and drifted to 39 of
 * 72 tools — the entire `ai`, `marketplace`, `apps`, `artifacts`, and `memory`
 * surfaces were undocumented, including the whole 3.2.0 repo-memory release.
 * Anything an agent reads to decide which tool to call has to be generated.
 *
 * Writes between SKILL-TOOLS-START / SKILL-TOOLS-END in the `.agents/` source
 * copy. Run `npm run mirror-skills` afterwards to update the Claude Code copy.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), "..");
const repoRoot = join(packageRoot, "..", "..");
const skillPath = join(repoRoot, ".agents", "skills", "testrelic-mcp", "SKILL.md");
const toolsEntry = join(packageRoot, "dist", "tools", "index.js");

const START = "<!-- SKILL-TOOLS-START -->";
const END = "<!-- SKILL-TOOLS-END -->";

// Ordered so the most commonly needed capabilities read first.
const CAP_ORDER = [
  "core", "coverage", "creation", "healing", "impact", "triage", "signals",
  "devtools", "ai", "marketplace", "apps", "artifacts", "memory",
];

function build(allTools) {
  const byCap = new Map();
  for (const t of allTools) {
    if (!byCap.has(t.capability)) byCap.set(t.capability, []);
    byCap.get(t.capability).push(t.name);
  }
  const caps = [...byCap.keys()].sort(
    (a, b) => (CAP_ORDER.indexOf(a) + 1 || 99) - (CAP_ORDER.indexOf(b) + 1 || 99),
  );
  const out = [START, ""];
  for (const cap of caps) {
    const names = byCap.get(cap).sort();
    out.push(`### ${cap}${cap === "core" ? " _(always on)_" : ""}`);
    out.push(names.map((n) => `\`${n}\``).join(" · "));
    out.push("");
  }
  out.push(`_${allTools.length} tools across ${caps.length} capabilities._`);
  out.push(END);
  return out.join("\n");
}

async function main() {
  if (!existsSync(toolsEntry)) {
    console.error(`Cannot find ${toolsEntry}. Run \`npm run build\` first.`);
    process.exit(2);
  }
  if (!existsSync(skillPath)) {
    console.error(`Cannot find ${skillPath}.`);
    process.exit(2);
  }
  const { ALL_TOOLS } = await import(pathToFileURL(toolsEntry).href);
  if (!Array.isArray(ALL_TOOLS) || ALL_TOOLS.length === 0) {
    console.error("ALL_TOOLS is empty — refusing to write an empty inventory.");
    process.exit(2);
  }
  const skill = readFileSync(skillPath, "utf-8");
  if (!skill.includes(START) || !skill.includes(END)) {
    console.error(`Markers ${START} / ${END} not found in ${skillPath}.`);
    process.exit(2);
  }
  const updated = skill.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`, "m"),
    build(ALL_TOOLS),
  );
  writeFileSync(skillPath, updated);
  console.log(`Updated ${skillPath} with ${ALL_TOOLS.length} tools.`);
}

await main();
