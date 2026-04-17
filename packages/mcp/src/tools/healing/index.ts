import { z } from "zod";
import { createPatch } from "diff";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";
import type { HealingPatch } from "../../types/index.js";
import { NotFoundError } from "../../errors.js";

/**
 * Healing capability — self-heal selectors, adjust waits, update assertions,
 * and replay failures. Uses the sampling bridge to let the client's model do
 * the synthesis; patches are returned as unified diffs so the agent can apply
 * them with `patch -p0` or an equivalent IDE action.
 */

export const healingTools: ToolDefinition[] = [
  {
    name: "tr_heal_run",
    capability: "healing",
    title: "Healer — propose a patch for a failing run",
    description:
      "Analyses a failing run's stack trace, error message, and test source, then proposes a patch (unified diff) to stabilise the test. Typical fixes: brittle-selector swap, timeout bump, flakiness gate, or assertion correction.",
    inputSchema: {
      run_id: z.string(),
      test_id: z.string().optional().describe("Focus on one failing test. Defaults to the first failure."),
    },
    outputSchema: {
      patch: z
        .object({
          run_id: z.string(),
          test_id: z.string(),
          reason: z.string(),
          unified_diff: z.string(),
          affected_files: z.array(z.string()),
          confidence: z.number(),
        })
        .optional(),
    },
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const run = await ctx.clients.testrelic.getRun(run_id);
      const failures = (await ctx.clients.testrelic.getRunFailures(run_id)).failures;
      if (!failures.length) {
        return { text: `No failures recorded for ${run_id}. Nothing to heal.`, structured: {} };
      }
      const target = input.test_id ? failures.find((f) => f.test_id === input.test_id) : failures[0];
      if (!target) throw new NotFoundError(`Test ${input.test_id} not found in failures for ${run_id}`);

      let source = "";
      let file = `tests/${target.suite}.spec.ts`;
      try {
        const src = await ctx.clients.testrelic.getTestSource(target.test_id);
        source = src.source;
        file = src.file;
      } catch {
        source = `// Source not available for ${target.test_id}`;
      }

      const prompt = [
        `A test failed. Propose the smallest possible patch that would make it reliable.`,
        `Test: ${target.test_name}`,
        `Error type: ${target.error_type}`,
        `Error message: ${target.error_message}`,
        `Stack trace:`,
        target.stack_trace,
        "",
        `Current source (${file}):`,
        "```ts",
        source,
        "```",
        "",
        `Return ONLY the full replacement source. Do not include markdown fences.`,
      ].join("\n");

      const sampled = await ctx.sampling.createMessage(prompt, {
        systemPrompt: "You are a senior SET. Prefer stable role-based locators and explicit expectations. Minimal changes only.",
        maxTokens: 1_400,
        temperature: 0.15,
      });

      let healed = sampled.text.replace(/```(?:ts|tsx|js|javascript|typescript)?\s*([\s\S]*?)```/m, "$1").trim();
      if (!healed) {
        healed = fallbackHeal(source, target.error_type);
      }

      const unified_diff = createPatch(file, source, healed, `${run_id} (broken)`, `${run_id} (healed)`);
      const confidence = sampled.fallback ? 0.35 : 0.72;

      const patch: HealingPatch = {
        run_id,
        test_id: target.test_id,
        reason: `Target error: ${target.error_type}. ${sampled.fallback ? "Template heuristic used (no sampling client)." : "Model-proposed patch."}`,
        unified_diff,
        affected_files: [file],
        confidence,
      };

      const text = [
        `## Healing Proposal — ${run_id} / ${target.test_name}`,
        `**Reason:** ${patch.reason}`,
        `**Confidence:** ${(confidence * 100).toFixed(0)}%`,
        `**Affected files:** ${patch.affected_files.join(", ")}`,
        "",
        "```diff",
        unified_diff,
        "```",
        "",
        run.status === "failed" ? "Apply with: `git apply` or equivalent. Re-run the test and confirm the fix." : "",
      ].join("\n");

      return { text, structured: { patch } };
    },
  },
  {
    name: "tr_suggest_locator",
    capability: "healing",
    title: "Suggest a stable locator",
    description:
      "Given a brittle selector (CSS / xpath / text), returns stable alternatives — getByRole, getByTestId, getByLabel — in order of preference. Framework-agnostic output.",
    inputSchema: {
      current_selector: z.string(),
      context: z.string().optional().describe("Surrounding context, e.g. `the checkout 'Pay' button on step 3`"),
      framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional().default("playwright"),
    },
    handler: async (input, ctx) => {
      const current = input.current_selector as string;
      const framework = (input.framework as string | undefined) ?? "playwright";
      const prompt = [
        `Replace this brittle selector: \`${current}\``,
        input.context ? `Context: ${String(input.context)}` : "",
        `Return 3 stable ${framework} locators in preference order. One per line, no prose.`,
      ]
        .filter(Boolean)
        .join("\n");
      const sampled = await ctx.sampling.createMessage(prompt, { temperature: 0.1, maxTokens: 250 });
      const suggestions = (sampled.text || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (!suggestions.length) {
        suggestions.push(
          framework === "playwright" ? `page.getByRole("button", { name: "..." })` : `cy.findByRole("button", { name: "..." })`,
          framework === "playwright" ? `page.getByTestId("...")` : `cy.get("[data-testid='...']")`,
          framework === "playwright" ? `page.getByLabel("...")` : `cy.findByLabelText("...")`,
        );
      }
      const text = ["## Stable locator suggestions", "", "```ts", ...suggestions, "```"].join("\n");
      return { text, structured: { current, suggestions, framework } };
    },
  },
  {
    name: "tr_replay_failure",
    capability: "healing",
    title: "Replay a failure locally",
    description:
      "Returns the artefacts (trace, video, screenshots) and a replay plan the agent can follow offline to reproduce the failure without hitting upstream services.",
    inputSchema: { run_id: z.string(), test_id: z.string().optional() },
    handler: async (input, ctx) => {
      const run_id = input.run_id as string;
      const failures = (await ctx.clients.testrelic.getRunFailures(run_id)).failures;
      const target = input.test_id ? failures.find((f) => f.test_id === input.test_id) : failures[0];
      if (!target) return { text: `No failure to replay in ${run_id}.`, structured: {} };
      let artifacts: Array<{ kind: string; url: string; note?: string }> = [];
      try {
        const res = await ctx.clients.testrelic.getRunArtifacts(run_id);
        artifacts = res.artifacts;
      } catch {
        artifacts = [];
      }
      if (target.video_url && !artifacts.find((a) => a.kind === "video")) {
        artifacts.push({ kind: "video", url: target.video_url, note: `seek to ${target.video_timestamp_ms}ms` });
      }
      if (target.screenshot_url && !artifacts.find((a) => a.kind === "screenshot")) {
        artifacts.push({ kind: "screenshot", url: target.screenshot_url });
      }
      const text = [
        `## Replay plan — ${run_id} / ${target.test_name}`,
        "",
        `1. Checkout the commit: \`git checkout ${(await ctx.clients.testrelic.getRun(run_id)).commit_sha}\``,
        `2. Open artefacts (below) to understand the failing step.`,
        `3. Re-run locally with the test id filter: e.g. \`pw test -g "${target.test_name}"\`.`,
        `4. Compare runtime state against the failing video timestamp.`,
        "",
        "### Artefacts",
        ...artifacts.map((a) => `- [${a.kind}](${a.url})${a.note ? ` — ${a.note}` : ""}`),
      ].join("\n");
      return { text, structured: { run_id, test: target, artifacts } };
    },
  },
];

function fallbackHeal(source: string, errorType: string): string {
  // Very conservative: bump timeouts, swap brittle selectors to testid pattern.
  let healed = source;
  if (/Timeout/i.test(errorType)) {
    healed = healed.replace(/timeout:\s*\d+/g, "timeout: 30000");
  }
  if (/Selector|NotFound|Locator/i.test(errorType)) {
    healed = healed.replace(/page\.locator\(["'][.#][^"']+["']\)/g, (m) => `${m} // TODO: replace with getByRole/getByTestId`);
  }
  return healed;
}

export function registerHealingTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of healingTools) register(t);
}
