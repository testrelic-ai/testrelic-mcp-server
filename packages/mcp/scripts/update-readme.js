#!/usr/bin/env node
/**
 * Generates the "Tools" section of the package README from src/tools/**.
 *
 * Parses each tool file's exported array of { name, capability, title,
 * description } entries and emits a table grouped by capability, replacing
 * the block between <!-- TOOLS-START --> and <!-- TOOLS-END -->.
 *
 * No TS runtime needed — we just regex the raw source. This keeps the
 * script dep-free and runnable on cold builds.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), "..");
const toolsDir = join(packageRoot, "src", "tools");
const readmePath = join(packageRoot, "README.md");

const START_MARK = "<!-- TOOLS-START -->";
const END_MARK = "<!-- TOOLS-END -->";

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function extractTools(source) {
  const tools = [];
  // Match each tool object by anchoring on `name:`, `capability:`, `title:`.
  // Description is read up to the next top-level key so multi-line strings
  // still land correctly.
  const re = /name:\s*"([^"]+)"\s*,\s*capability:\s*"([^"]+)"\s*,\s*title:\s*"([^"]+)"\s*,\s*description:\s*([\s\S]*?),\s*(?:inputSchema|outputSchema|aliases|deprecated|handler)\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, name, capability, title, rawDesc] = m;
    // Collapse concatenated string literals ("a" + "b") and normalise.
    const cleaned = rawDesc
      .replace(/\\"/g, '"')
      .replace(/"\s*\+\s*\n?\s*"/g, "")
      .trim();
    const strMatch = cleaned.match(/^["'`]([\s\S]*?)["'`]$/);
    const description = strMatch
      ? strMatch[1].trim().split(/\s+/).join(" ")
      : cleaned.split(/\s+/).join(" ").slice(0, 200);
    tools.push({ name, capability, title, description });
  }
  return tools;
}

function generateTable(allTools) {
  const byCap = new Map();
  for (const t of allTools) {
    if (!byCap.has(t.capability)) byCap.set(t.capability, []);
    byCap.get(t.capability).push(t);
  }
  const lines = [
    START_MARK,
    "",
    "_Auto-generated. Edit the tool source files, then run `npm run update-readme`._",
    "",
    "| Capability | Tool | Purpose |",
    "|---|---|---|",
  ];
  for (const [cap, list] of [...byCap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const t of list.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| \`${cap}\` | \`${t.name}\` | ${t.title}. ${t.description.replace(/\|/g, "\\|")} |`);
    }
  }
  lines.push("", END_MARK);
  return lines.join("\n");
}

function main() {
  const files = walk(toolsDir).filter((f) => f.endsWith("index.ts"));
  const allTools = [];
  for (const f of files) {
    try {
      const text = readFileSync(f, "utf-8");
      allTools.push(...extractTools(text));
    } catch (err) {
      console.warn(`skip ${f}: ${err.message}`);
    }
  }
  if (!allTools.length) {
    console.error("No tools found. Check that src/tools/**/index.ts files export tool arrays.");
    process.exit(2);
  }
  const readme = readFileSync(readmePath, "utf-8");
  const block = generateTable(allTools);
  let updated;
  if (readme.includes(START_MARK) && readme.includes(END_MARK)) {
    updated = readme.replace(new RegExp(`${START_MARK}[\\s\\S]*?${END_MARK}`, "m"), block);
  } else {
    updated = `${readme}\n\n## Tools\n\n${block}\n`;
  }
  writeFileSync(readmePath, updated);
  console.log(`Updated ${readmePath} with ${allTools.length} tools.`);
}

main();
