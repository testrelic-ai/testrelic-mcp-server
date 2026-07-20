#!/usr/bin/env node
/**
 * Generates the "Tools" section of the package README from the real
 * `ALL_TOOLS` array, replacing the block between the TOOLS-START / TOOLS-END
 * markers.
 *
 * Why this imports the build instead of parsing source:
 *
 * Until 3.3.0 this script regex-scraped `src/tools/** /index.ts`, anchoring on
 * a literal `name: "...", capability: "...", title: "..."` object shape. That
 * was dep-free and worked on cold builds, but it silently skipped every tool
 * that was not written as a literal object — the five factory-generated
 * `tr_generate_*` tools never appeared in the README at all, so the published
 * docs listed 67 of 72 tools and nobody could tell. A docs generator that
 * silently under-reports is worse than one that needs a build first.
 *
 * Requires `npm run build` to have produced dist/. Fails loudly if it hasn't,
 * rather than emitting a partial table.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), "..");
const readmePath = join(packageRoot, "README.md");
const toolsEntry = join(packageRoot, "dist", "tools", "index.js");

const START_MARK = "<!-- TOOLS-START -->";
const END_MARK = "<!-- TOOLS-END -->";

function escapeCell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function generateTable(allTools) {
  const byCap = new Map();
  for (const t of allTools) {
    if (!byCap.has(t.capability)) byCap.set(t.capability, []);
    byCap.get(t.capability).push(t);
  }

  const aliasCount = allTools.reduce((n, t) => n + (t.aliases?.length ?? 0), 0);
  const lines = [
    START_MARK,
    "",
    "_Auto-generated from `ALL_TOOLS`. Edit the tool source files, run `npm run build`, then `npm run update-readme`._",
    "",
    `**${allTools.length} tools** across ${byCap.size} capabilities. ` +
      "Only `core` is always on; the rest are opt-in via `--caps` / `TESTRELIC_MCP_CAPS`.",
    "",
    "| Capability | Tool | Purpose |",
    "|---|---|---|",
  ];
  for (const [cap, list] of [...byCap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const t of list.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| \`${cap}\` | \`${t.name}\` | ${escapeCell(`${t.title}. ${t.description}`)} |`);
    }
  }

  // Deprecated aliases previously existed only in source; surface them so v1
  // users can find their migration target without reading the registry.
  if (aliasCount > 0) {
    lines.push(
      "",
      `### Deprecated v1 aliases (${aliasCount})`,
      "",
      "Off by default since 3.3.0. Enable with `--legacy-aliases` or " +
        "`TESTRELIC_MCP_LEGACY_ALIASES=1` only while migrating; each one duplicates " +
        "a `tr_*` tool the client already sees.",
      "",
      "| Deprecated name | Use instead |",
      "|---|---|",
    );
    const rows = [];
    for (const t of allTools) {
      for (const a of t.aliases ?? []) rows.push([a.name, t.name]);
    }
    for (const [from, to] of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| \`${from}\` | \`${to}\` |`);
    }
  }

  lines.push("", END_MARK);
  return lines.join("\n");
}

async function main() {
  if (!existsSync(toolsEntry)) {
    console.error(
      `Cannot find ${toolsEntry}.\n` +
        "The README tool tables are generated from the compiled ALL_TOOLS array.\n" +
        "Run `npm run build` first, then re-run `npm run update-readme`.",
    );
    process.exit(2);
  }

  const { ALL_TOOLS } = await import(pathToFileURL(toolsEntry).href);
  if (!Array.isArray(ALL_TOOLS) || ALL_TOOLS.length === 0) {
    console.error("ALL_TOOLS is empty — refusing to write a table that would drop every tool.");
    process.exit(2);
  }

  const readme = readFileSync(readmePath, "utf-8");
  const block = generateTable(ALL_TOOLS);
  const updated =
    readme.includes(START_MARK) && readme.includes(END_MARK)
      ? readme.replace(new RegExp(`${START_MARK}[\\s\\S]*?${END_MARK}`, "m"), block)
      : `${readme}\n\n## Tools\n\n${block}\n`;

  writeFileSync(readmePath, updated);
  const aliasCount = ALL_TOOLS.reduce((n, t) => n + (t.aliases?.length ?? 0), 0);
  console.log(
    `Updated ${readmePath} with ${ALL_TOOLS.length} tools and ${aliasCount} deprecated aliases.`,
  );
}

await main();
