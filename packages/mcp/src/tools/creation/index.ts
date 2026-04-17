import { z } from "zod";
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolContext, ToolDefinition } from "../../registry/index.js";
import { TEMPLATES } from "./templates.js";
import type { TestPlan } from "../../types/index.js";
import { NotFoundError } from "../../errors.js";

const execFileAsync = promisify(execFile);

/**
 * Creation capability — Planner, Generator, DryRun, AssertionHelper,
 * TemplateCatalog. Uses sampling for LLM-driven synthesis with deterministic
 * fallbacks so the tools always return something useful even offline.
 */

export const creationTools: ToolDefinition[] = [
  {
    name: "tr_list_templates",
    capability: "creation",
    title: "List framework templates",
    description: "Returns available test framework templates (Playwright, Cypress, Jest, Vitest).",
    inputSchema: {},
    handler: async () => {
      const lines = ["## Test Framework Templates", ""];
      const entries = Object.values(TEMPLATES).map((t) => ({
        framework: t.framework,
        extension: t.extension,
        description: t.description,
      }));
      for (const t of entries) lines.push(`- **${t.framework}** (\`${t.extension}\`) — ${t.description}`);
      return { text: lines.join("\n"), structured: { templates: entries } };
    },
  },
  {
    name: "tr_plan_test",
    capability: "creation",
    title: "Planner — design a test plan",
    description:
      "Produces a Markdown test plan for a journey gap. Input either a journey_id (preferred) or a freeform goal. Missing PRD/acceptance info is requested via elicitation; the result is cache-keyed on the journey signature.",
    inputSchema: {
      project_id: z.string(),
      journey_id: z.string().optional(),
      goal: z.string().optional().describe("Freeform goal if journey_id is unknown"),
      framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional().default("playwright"),
      prd: z.string().optional().describe("PRD or acceptance criteria. If omitted, we'll try to elicit it."),
    },
    outputSchema: {
      plan: z.object({
        journey_id: z.string().optional(),
        goal: z.string(),
        framework: z.string(),
        steps: z.array(z.object({ step: z.number(), action: z.string(), expectation: z.string() })),
        data_requirements: z.array(z.string()).optional(),
      }),
      cache_key: z.string(),
    },
    handler: async (input, ctx) => {
      const project_id = input.project_id as string;
      const journey_id = input.journey_id as string | undefined;
      const framework = (input.framework as TestPlan["framework"] | undefined) ?? "playwright";
      let goal = input.goal as string | undefined;
      let prd = input.prd as string | undefined;

      let journey;
      if (journey_id) {
        journey = await ctx.context.journeys.byId(project_id, journey_id);
        if (!journey) throw new NotFoundError(`Journey ${journey_id} not found for ${project_id}`);
        goal = goal ?? `Cover the user journey "${journey.name}" end-to-end in ${framework}.`;
      }
      if (!goal) {
        return { text: "No goal or journey_id provided. Pass `goal` or `journey_id`.", structured: {} };
      }

      if (!prd) {
        const elicited = await ctx.elicit.ask({
          message: `Any PRD, acceptance criteria, or edge cases for "${goal}"? (optional)`,
          schema: z.object({ prd: z.string().optional() }),
        });
        if (elicited.kind === "accepted" && typeof elicited.content.prd === "string") prd = elicited.content.prd;
      }

      const cache_key = ctx.cache.key("tr_plan_test", { project_id, journey_id, goal, framework, prd });
      const hit = ctx.cache.get<{ plan: TestPlan; text: string }>(cache_key);
      if (hit) {
        return { text: hit.value.text, structured: { plan: hit.value.plan, cache_key }, cacheKey: cache_key };
      }

      // Try sampling; fall back to deterministic skeleton.
      const samplingPrompt = [
        `Design a ${framework} test plan that covers the following journey.`,
        journey ? `Journey path: ${journey.events.join(" → ")}` : "",
        `Goal: ${goal}`,
        prd ? `PRD / acceptance criteria:\n${prd}` : "",
        "",
        "Respond with a JSON object matching:",
        '{ "steps": [{ "step": 1, "action": "...", "expectation": "..." }], "data_requirements": ["..."] }',
      ]
        .filter(Boolean)
        .join("\n");

      const sampled = await ctx.sampling.createMessage(samplingPrompt, {
        systemPrompt:
          "You are a senior test engineer writing thorough, deterministic end-to-end tests. Prefer stable locators and explicit assertions.",
        maxTokens: 800,
        temperature: 0.2,
      });

      const plan: TestPlan = {
        journey_id,
        goal,
        framework,
        steps: [],
      };

      if (!sampled.fallback && sampled.text) {
        try {
          const m = sampled.text.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]) as { steps?: Array<{ step: number; action: string; expectation: string }>; data_requirements?: string[] };
            if (Array.isArray(parsed.steps)) plan.steps = parsed.steps;
            if (Array.isArray(parsed.data_requirements)) plan.data_requirements = parsed.data_requirements;
          }
        } catch {
          // fall through to skeleton
        }
      }

      if (plan.steps.length === 0 && journey) {
        plan.steps = journey.events.map((event, i) => ({
          step: i + 1,
          action: `Trigger event "${event}"`,
          expectation: `Expect the user to reach the next step of ${journey.name}`,
        }));
      }
      if (plan.steps.length === 0) {
        plan.steps = [
          { step: 1, action: "Navigate to the target page", expectation: "Page loads successfully" },
          { step: 2, action: `Perform the action implied by: ${goal}`, expectation: "Expected outcome visible" },
          { step: 3, action: "Assert the final state", expectation: "State matches acceptance criteria" },
        ];
      }

      const text = [
        `## Test Plan — ${plan.goal}`,
        journey ? `**Journey:** \`${journey.id}\` · ${journey.events.join(" → ")}` : "",
        `**Framework:** ${plan.framework}`,
        "",
        "### Steps",
        ...plan.steps.map((s) => `${s.step}. **${s.action}** → _${s.expectation}_`),
        plan.data_requirements && plan.data_requirements.length ? `\n### Data requirements\n${plan.data_requirements.map((d) => `- ${d}`).join("\n")}` : "",
        "",
        "Next step: call `tr_generate_test` with this plan to produce runnable code.",
      ]
        .filter(Boolean)
        .join("\n");

      ctx.cache.set(cache_key, { plan, text }, { ttlSeconds: 3600 });

      return { text, structured: { plan, cache_key }, cacheKey: cache_key };
    },
  },
  {
    name: "tr_generate_test",
    capability: "creation",
    title: "Generator — produce runnable test code",
    description:
      "Generates runnable test code (Playwright by default) from a plan. Uses sampling for synthesis with a deterministic template fallback. Writes to {outputDir}/generated/ and returns both the code and a cache_key.",
    inputSchema: {
      project_id: z.string(),
      plan_cache_key: z.string().optional().describe("Cache key returned by tr_plan_test"),
      plan: z
        .object({
          journey_id: z.string().optional(),
          goal: z.string(),
          framework: z.enum(["playwright", "cypress", "jest", "vitest"]),
          steps: z.array(z.object({ step: z.number(), action: z.string(), expectation: z.string() })),
          data_requirements: z.array(z.string()).optional(),
        })
        .optional(),
      file_name: z.string().optional(),
    },
    outputSchema: {
      file_path: z.string(),
      framework: z.string(),
      cache_key: z.string(),
      code: z.string(),
    },
    handler: async (input, ctx) => {
      let plan: TestPlan | undefined = input.plan as TestPlan | undefined;
      if (!plan && input.plan_cache_key) {
        const cached = ctx.cache.get<{ plan: TestPlan }>(input.plan_cache_key as string);
        if (cached) plan = cached.value.plan;
      }
      if (!plan) {
        return {
          text: "No plan found. Pass a `plan` object directly or a `plan_cache_key` from tr_plan_test.",
          structured: {},
        };
      }
      const template = TEMPLATES[plan.framework];
      if (!template) {
        return { text: `Framework "${plan.framework}" has no template. Try playwright, cypress, jest, or vitest.`, structured: {} };
      }
      const file_name = (input.file_name as string | undefined) ?? `generated-${plan.journey_id ?? Date.now()}${template.extension}`;
      const outDir = join(ctx.config.outputDir, "generated");
      mkdirSync(outDir, { recursive: true });
      const file_path = join(outDir, file_name);

      const samplingPrompt = [
        `Write ${plan.framework} test code for the following plan:`,
        `Goal: ${plan.goal}`,
        "Steps:",
        ...plan.steps.map((s) => `  ${s.step}. ${s.action} → expect: ${s.expectation}`),
        plan.data_requirements?.length ? `Data: ${plan.data_requirements.join("; ")}` : "",
        "",
        `Return ONLY the body of the test function — one line per action. Use stable locators (getByRole, getByTestId). No preamble, no imports, no \`test(...)\` wrapper.`,
      ]
        .filter(Boolean)
        .join("\n");

      const sampled = await ctx.sampling.createMessage(samplingPrompt, {
        systemPrompt: "You are a senior QA engineer. Write deterministic test code with clear assertions.",
        maxTokens: 1_200,
        temperature: 0.15,
      });

      const steps: string[] = [];
      if (!sampled.fallback && sampled.text.trim()) {
        for (const line of sampled.text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("```")) continue;
          steps.push(trimmed);
        }
      }
      if (!steps.length) {
        for (const s of plan.steps) {
          if (plan.framework === "playwright") {
            steps.push(`// Step ${s.step}: ${s.action}`);
            steps.push(`await test.step("${s.action.replace(/"/g, '\\"')}", async () => { /* TODO: ${s.expectation} */ });`);
          } else if (plan.framework === "cypress") {
            steps.push(`cy.log("${s.action.replace(/"/g, '\\"')}"); // TODO: ${s.expectation}`);
          } else {
            steps.push(`// Step ${s.step}: ${s.action} — expect: ${s.expectation}`);
            steps.push(`expect(true).toBe(true);`);
          }
        }
      }

      const code = template.skeleton({ testName: plan.goal, steps });
      writeFileSync(file_path, code, "utf-8");

      const cache_key = ctx.cache.key("tr_generate_test", { plan, file_name });
      const sha = ctx.cache.blob.write(code);
      ctx.cache.set(cache_key, { file_path, framework: plan.framework, blob: sha }, { ttlSeconds: 3_600 });

      const text = [
        `## Generated ${plan.framework} test`,
        `**File:** \`${file_path}\``,
        `**Fallback used:** ${sampled.fallback ? "yes (no sampling client)" : "no"}`,
        "",
        "```" + (plan.framework === "cypress" ? "ts" : "ts"),
        code,
        "```",
        "",
        "Next step: call `tr_dry_run_test` with this file path to verify it compiles.",
      ].join("\n");

      return {
        text,
        structured: { file_path, framework: plan.framework, cache_key, code },
        cacheKey: cache_key,
      };
    },
  },
  {
    name: "tr_dry_run_test",
    capability: "creation",
    title: "Dry-run: tsc + framework list",
    description:
      "Type-checks the generated file (`tsc --noEmit`) and lists tests (`playwright test --list` when applicable). Returns first-pass errors so the agent can iterate before committing.",
    inputSchema: {
      file_path: z.string().describe("Path to the generated test file"),
      framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional().default("playwright"),
    },
    handler: async (input, ctx) => {
      const file = input.file_path as string;
      const framework = (input.framework as string | undefined) ?? "playwright";
      const results: { step: string; ok: boolean; output: string }[] = [];

      try {
        const { stdout, stderr } = await execFileAsync("npx", ["--yes", "tsc", "--noEmit", "--skipLibCheck", file], {
          cwd: process.cwd(),
          timeout: ctx.config.timeouts.analysis,
        });
        results.push({ step: "tsc --noEmit", ok: true, output: stdout + stderr });
      } catch (err) {
        const anyErr = err as { stdout?: string; stderr?: string; message?: string };
        results.push({
          step: "tsc --noEmit",
          ok: false,
          output: `${anyErr.stdout ?? ""}\n${anyErr.stderr ?? ""}\n${anyErr.message ?? ""}`.trim() || String(err),
        });
      }

      if (framework === "playwright") {
        try {
          const { stdout, stderr } = await execFileAsync("npx", ["--yes", "playwright", "test", "--list", file], {
            cwd: process.cwd(),
            timeout: ctx.config.timeouts.analysis,
          });
          results.push({ step: "playwright test --list", ok: true, output: stdout + stderr });
        } catch (err) {
          const anyErr = err as { stdout?: string; stderr?: string; message?: string };
          results.push({
            step: "playwright test --list",
            ok: false,
            output: `${anyErr.stdout ?? ""}\n${anyErr.stderr ?? ""}\n${anyErr.message ?? ""}`.trim() || String(err),
          });
        }
      }

      const ok = results.every((r) => r.ok);
      const text = [
        `## Dry-run: ${ok ? "PASS" : "FAIL"}`,
        ...results.flatMap((r) => [
          "",
          `### ${r.step}: ${r.ok ? "✅" : "❌"}`,
          "```",
          r.output.slice(0, 2_000),
          "```",
        ]),
      ].join("\n");

      return { text, structured: { ok, results, file } };
    },
  },
  {
    name: "tr_generate_assertion",
    capability: "creation",
    title: "Generate a stable assertion",
    description:
      "TestRelic parallel to Playwright's browser_generate_locator. Given a journey step, returns a stable framework-appropriate assertion the agent can paste into a test.",
    inputSchema: {
      step: z.string().describe("The journey step to assert, e.g. 'payment success banner visible'"),
      framework: z.enum(["playwright", "cypress", "jest", "vitest"]).optional().default("playwright"),
    },
    handler: async (input, ctx) => {
      const step = input.step as string;
      const framework = (input.framework as string | undefined) ?? "playwright";
      const prompt = `Return a single-line ${framework} assertion that confirms: "${step}". Prefer role-based selectors. No preamble.`;
      const sampled = await ctx.sampling.createMessage(prompt, { temperature: 0.1, maxTokens: 120 });
      let assertion = sampled.text.trim().split(/\r?\n/)[0] ?? "";
      if (!assertion) {
        assertion =
          framework === "playwright"
            ? `await expect(page.getByText(${JSON.stringify(step)})).toBeVisible();`
            : framework === "cypress"
              ? `cy.contains(${JSON.stringify(step)}).should("be.visible");`
              : `expect(screen.getByText(${JSON.stringify(step)})).toBeTruthy();`;
      }
      return {
        text: ["```ts", assertion, "```"].join("\n"),
        structured: { framework, assertion, fallback: sampled.fallback },
      };
    },
  },
];

export function registerCreationTools(ctx: ToolContext, register: (def: ToolDefinition) => void): void {
  for (const t of creationTools) register(t);
}
