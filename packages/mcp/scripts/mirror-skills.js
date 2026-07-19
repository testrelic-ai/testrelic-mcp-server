#!/usr/bin/env node
/**
 * Mirrors `.agents/skills/` (the source of truth) into agent-specific skill
 * directories that do not read it.
 *
 * `.agents/skills/<name>/SKILL.md` is read natively by Codex (its primary
 * skills path), Cursor, Copilot/VS Code, Gemini CLI, and Windsurf. Claude Code
 * reads `.claude/skills/` only, so it needs a generated copy.
 *
 * Copies rather than symlinks: symlinks on Windows require Administrator or
 * Developer Mode, and a copy lets `--check` detect drift in CI.
 *
 *   node scripts/mirror-skills.js           # write mirrors
 *   node scripts/mirror-skills.js --check   # exit 1 if any mirror is stale
 */

import { readdirSync, statSync, existsSync, mkdirSync, rmSync, cpSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), "..");
const repoRoot = join(packageRoot, "..", "..");
const SOURCE = join(repoRoot, ".agents", "skills");
const TARGETS = [
  // Claude Code reads only this path.
  join(repoRoot, ".claude", "skills"),
  // npm `files` globs resolve relative to the PACKAGE directory, not the repo
  // root, so a skill that lives at the repo root never reaches the tarball.
  // That is exactly how the previous `.cursor/skills/**/*` entry shipped
  // nothing from a clean clone. Staged here by `prepack`.
  join(packageRoot, ".agents", "skills"),
];

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

function skillDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "SKILL.md")));
}

const check = process.argv.includes("--check");
const skills = skillDirs(SOURCE);

if (skills.length === 0) {
  console.error(`No skills found under ${SOURCE}`);
  process.exit(check ? 1 : 0);
}

const stale = [];
let wrote = 0;

for (const skill of skills) {
  const name = skill.split(/[\\/]/).pop();
  for (const targetRoot of TARGETS) {
    const dest = join(targetRoot, name);
    if (check) {
      if (!existsSync(dest)) {
        stale.push(`${dest} (missing)`);
        continue;
      }
      const srcFiles = listFiles(skill).sort();
      const dstFiles = listFiles(dest).sort();
      if (srcFiles.join("|") !== dstFiles.join("|")) {
        stale.push(`${dest} (file set differs)`);
        continue;
      }
      for (const f of srcFiles) {
        if (readFileSync(join(skill, f), "utf-8") !== readFileSync(join(dest, f), "utf-8")) {
          stale.push(`${dest}/${f} (content differs)`);
        }
      }
    } else {
      mkdirSync(targetRoot, { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(skill, dest, { recursive: true });
      console.log(`mirrored ${name} -> ${dest}`);
      wrote += 1;
    }
  }
}

if (check) {
  for (const s of stale) console.error(`STALE: ${s}`);
  if (stale.length) {
    console.error(
      `\n${stale.length} stale mirror(s). Run \`npm run mirror-skills\` and commit the result.\n` +
        "Never edit a mirrored copy directly — edit .agents/skills/ and regenerate.",
    );
    process.exit(1);
  }
  console.log("PASS: all skill mirrors current");
} else {
  console.log(`${wrote} mirror(s) written`);
}
