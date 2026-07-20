/**
 * Targeted real-data test of the flakiness unit fix (3.3.1).
 * Runs tr_flaky_audit with threshold 0 across repos until it renders NON-EMPTY
 * results — the exact path that threw `Invalid count value: -810` on 0–100
 * scores. Read-only. Prints the rendered score bars so units are eyeballable.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../packages/mcp/src/index.js";
import { ALL_TOOLS } from "../packages/mcp/src/tools/index.js";
import type { Capability } from "../packages/mcp/src/config.js";

async function main(): Promise<number> {
  const cloudUrl = process.env.TESTRELIC_CLOUD_URL!;
  const token = process.env.TESTRELIC_MCP_TOKEN!;
  const id = randomUUID().slice(0, 8);
  const srv = await createServer({
    capabilities: ["core", "triage"] as Capability[], mockMode: false, logLevel: "warn",
    isolated: true, saveSession: false, cloud: { baseUrl: cloudUrl, token },
    outputDir: join(tmpdir(), `tr-fp-out-${id}`), cacheDir: join(tmpdir(), `tr-fp-cache-${id}`),
  });
  const tool = ALL_TOOLS.find((t) => t.name === "tr_flaky_audit")!;
  const repos = srv.__ctx.bootstrap?.repos ?? [];
  let hits = 0;
  try {
    // org-wide first (no project_id), then per-repo until we render some rows.
    const targets: Array<string | undefined> = [undefined, ...repos.map((r) => r.id)];
    for (const pid of targets) {
      const r = (await tool.handler(
        { ...(pid ? { project_id: pid } : {}), threshold: 0, days: 90 },
        srv.__ctx,
      )) as { text: string; structured?: { tests?: Array<{ flakiness_score: number }> }; isError?: boolean };
      const tests = r.structured?.tests ?? [];
      if (r.isError) { console.log(`[FAIL] ${pid ?? "(org)"}: isError ${r.text.slice(0, 80)}`); continue; }
      if (tests.length === 0) continue;
      hits++;
      const label = pid ? repos.find((x) => x.id === pid)?.displayName ?? pid : "(org-wide)";
      const scores = tests.map((t) => t.flakiness_score);
      const outOfRange = scores.filter((s) => s < 0 || s > 1);
      const bars = (r.text.match(/[█░]+/g) ?? []);
      const badBar = bars.filter((b) => b.length !== 10);
      console.log(`[HIT] ${label}: ${tests.length} flaky, `
        + `score range ${Math.min(...scores).toFixed(3)}–${Math.max(...scores).toFixed(3)}, `
        + `out-of-[0,1]=${outOfRange.length}, bars=${bars.length}, malformed-bars=${badBar.length}`);
      // show the first two rendered rows so the units are visually verifiable
      for (const line of r.text.split("\n").filter((l) => /[█░]/.test(l)).slice(0, 2)) {
        console.log("      " + line.trim());
      }
      if (outOfRange.length || badBar.length) { console.log("  ^^ UNIT BUG STILL PRESENT"); return 1; }
      if (hits >= 3) break;
    }
  } finally { await srv.stop().catch(() => undefined); }

  console.log(hits ? `\n${hits} repo(s) rendered real flaky data cleanly — unit fix holds on live scores.`
                   : "\nNo repo had flaky tests even at threshold 0 — path not exercisable on this data.");
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
